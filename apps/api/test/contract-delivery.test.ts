import { generateKeyPairSync } from 'node:crypto';
import express, { type Express, type Router } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@relayd/logger';
import { FEATURES, PLANS } from '@relayd/billing';
import { audienceFingerprint } from '@relayd/campaigns';
import type { GlobalMembershipRepository } from '@relayd/db';
import type {
  CampaignId,
  SendingPoolId,
  TemplateId,
  TemplateVersionId,
  UserId,
  WorkspaceId,
} from '@relayd/types';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { analyticsRoutes } from '../src/routes/analytics.js';
import { billingRoutes } from '../src/routes/billing.js';
import { campaignRoutes } from '../src/routes/campaigns.js';
import { outboundWebhookRoutes } from '../src/routes/outbound-webhooks.js';
import { poolRoutes } from '../src/routes/pools.js';
import { providerRoutes } from '../src/routes/providers.js';
import { templateRoutes } from '../src/routes/templates.js';
import { TokenService } from '../src/services/tokens.js';
import type { AnalyticsService } from '../src/services/analytics.js';
import {
  BillingService,
  type BillingRepositoryLike,
  type BillingServiceOptions,
} from '../src/services/billing.js';
import {
  CampaignService,
  type CampaignRepositories,
  type CampaignServiceOptions,
} from '../src/services/campaigns.js';
import type { OutboundWebhookService } from '../src/services/outbound-webhooks.js';
import type { PoolService } from '../src/services/pools.js';
import type { ProviderService } from '../src/services/providers.js';
import type { TemplateService } from '../src/services/templates.js';

/**
 * The contract between `apps/web`'s API client and the delivery half of the
 * API: campaigns, templates, providers and senders, pools, outbound
 * webhooks, billing and analytics.
 *
 * ## Why this file exists
 *
 * `apps/web/src/api/client.ts` hands `envelope.data` straight to the caller,
 * so when a client declares
 *
 *     api.get<{ items: Campaign[]; nextCursor: string | null }>('/campaigns')
 *
 * the route's `res.json({ data: X })` must make `X` structurally that. When
 * it does not, nothing throws: React renders an empty table, a blank card or
 * the word "undefined", and the page looks like a product decision rather
 * than a bug. Neither suite catches it — every web test mocks `fetch` and
 * every API test asserts the API's own shape — so the two halves can drift
 * indefinitely and only a customer finds out.
 *
 * Each block below names a client declaration and asserts the response
 * carries the keys that declaration marks **required**, with the right
 * primitive type and the right nullability. `string | null` and
 * `string | undefined` are not the same thing here: one renders as an em
 * dash and the other renders as nothing or crashes a `.toFixed`.
 *
 * Fields the client marks optional are deliberately *not* asserted. Those
 * are the `BACKEND PENDING` gaps, and a test that demanded them would fail
 * for a reason the code already documents.
 *
 * ## How the doubles are wired
 *
 * Where the *service* does the shaping — the campaign counters, the billing
 * overview — the real service runs against fake repositories, because
 * stubbing the service would test the route's `res.json` and skip the bug.
 * Everywhere else the service is stubbed, and every stub method carries an
 * explicit `Promise<Awaited<ReturnType<Service[...]>>>` return type, so the
 * fixture is checked against the real service signature at compile time and
 * the response is checked against the client's declaration at run time.
 */

/* ------------------------------------------------------------ assertions -- */

type Check = (value: unknown) => boolean;

const str: Check = (v) => typeof v === 'string';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const bool: Check = (v) => typeof v === 'boolean';
const anything: Check = () => true;

const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);

const arrayOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);

const isObject: Check = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const recordOf =
  (check: Check): Check =>
  (v) =>
    isObject(v) && Object.values(v as Record<string, unknown>).every(check);

const oneOf =
  (...allowed: readonly unknown[]): Check =>
  (v) =>
    allowed.includes(v);

/** An ISO instant, which is what a `Date` becomes in `res.json`. */
const isoString: Check = (v) => str(v) && !Number.isNaN(Date.parse(v as string));

type Spec = Readonly<Record<string, Check>>;

const shaped =
  (spec: Spec): Check =>
  (v) =>
    isObject(v) && problemsIn(v as Record<string, unknown>, spec).length === 0;

function problemsIn(value: Record<string, unknown>, spec: Spec): string[] {
  const problems: string[] = [];

  for (const [key, check] of Object.entries(spec)) {
    // `in` rather than `!== undefined`: a field the service set to
    // `undefined` is dropped by JSON.stringify and arrives absent, which is
    // exactly the failure a client declaring it required would hit.
    if (!(key in value)) {
      problems.push(`${key}: absent`);
      continue;
    }

    if (!check(value[key])) problems.push(`${key}: ${JSON.stringify(value[key])}`);
  }

  return problems;
}

/**
 * Asserts a body carries every field a client declares, and reports all of
 * the misses at once.
 *
 * One failure per endpoint rather than per field, because the useful thing
 * to read when a contract breaks is the whole list — fixing them one
 * `expect` at a time is six runs of the suite.
 */
function expectShape(body: unknown, spec: Spec, where: string): void {
  expect(isObject(body), `${where}: expected an object, got ${JSON.stringify(body)}`).toBe(true);
  expect(problemsIn(body as Record<string, unknown>, spec), where).toEqual([]);
}

function expectEachShape(body: unknown, spec: Spec, where: string): void {
  expect(Array.isArray(body), `${where}: expected an array, got ${JSON.stringify(body)}`).toBe(
    true,
  );

  const rows = body as unknown[];
  expect(rows.length, `${where}: the fixture must return at least one row`).toBeGreaterThan(0);

  rows.forEach((row, index) => expectShape(row, spec, `${where}[${index}]`));
}

/* ------------------------------------------------------------------ auth -- */

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const tokens = new TokenService({
  privateKeyPem: privateKey,
  publicKeyPem: publicKey,
  keyId: 'k1',
  accessTokenTtlSeconds: 900,
});

const WS = 'ws-a' as WorkspaceId;
const USER = 'user-1' as UserId;
const CAMPAIGN = 'c1' as CampaignId;

const memberships = {
  async findMembership(userId: UserId, workspaceId: WorkspaceId) {
    // Owner, because this file is about shapes. Which role may reach which
    // path is proved by the route tests next door.
    return userId === USER && workspaceId === WS
      ? { workspaceId: WS, workspaceName: 'ws', workspaceSlug: 'ws', role: 'owner' as const }
      : null;
  },
} as unknown as GlobalMembershipRepository;

let bearer: string;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

function mount(router: Router): Express {
  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use('/api/v1', router);
  app.use(
    errorEnvelope(
      createLogger({ name: 'contract', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

type Method = 'get' | 'post' | 'patch' | 'delete';

/** The request the browser would make: bearer token plus workspace header. */
async function call(
  app: Express,
  method: Method,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const pending = request(app)[method](path)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Workspace-Id', WS);

  const response = await (body === undefined ? pending : pending.send(body as object));

  // Surfaced as the assertion message: a 500 whose body is an error envelope
  // otherwise fails as "code: absent", which says nothing about why.
  expect(
    response.status < 400,
    `${method.toUpperCase()} ${path} answered ${response.status}: ${JSON.stringify(response.body)}`,
  ).toBe(true);

  return { status: response.status, data: (response.body as { data: unknown }).data };
}

/* -------------------------------------------------------------- campaigns -- */

/**
 * `apps/web/src/api/campaigns.ts`, `Campaign`.
 *
 * `audience` is `unknown` in the row and a `{ listIds?, segmentIds? }` in
 * the client, so it is asserted as an object and no more: what is inside it
 * is the wizard's, written by the wizard.
 */
const CAMPAIGN_SHAPE: Spec = {
  id: str,
  name: str,
  status: str,
  subjectOverride: nullable(str),
  templateVersionId: nullable(str),
  senderAccountId: nullable(str),
  sendingPoolId: nullable(str),
  audience: isObject,
  scheduledAt: nullable(isoString),
  timezone: nullable(str),
  recipientCount: num,
  launchedAt: nullable(isoString),
  completedAt: nullable(isoString),
  createdAt: isoString,
  updatedAt: isoString,
};

/** `CampaignProgress` — what the polled progress bar and the tiles read. */
const PROGRESS_SHAPE: Spec = {
  total: num,
  pending: num,
  queued: num,
  sending: num,
  sent: num,
  failed: num,
  suppressed: num,
  uncertain: num,
  outstanding: num,
  complete: bool,
  deliveryUncertain: num,
};

const CAMPAIGN_ROW = {
  id: CAMPAIGN,
  workspaceId: WS,
  name: 'Spring escapes',
  status: 'draft',
  templateVersionId: null,
  senderAccountId: null,
  sendingPoolId: null,
  audience: {},
  subjectOverride: null,
  throttlePerHour: null,
  scheduledAt: null,
  timezone: 'Asia/Dubai',
  recipientCount: 0,
  launchedAt: null,
  completedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  archivedAt: null,
};

const COUNTERS_ROW = {
  campaignId: CAMPAIGN,
  total: 1000,
  pending: 200,
  queued: 50,
  sending: 10,
  sent: 700,
  failed: 30,
  suppressed: 5,
  uncertain: 5,
  updatedAt: new Date('2026-09-19T12:00:00.000Z'),
};

const RECIPIENT_ROW = {
  id: 'r1',
  email: 'amira@example.ae',
  state: 'delivered',
  deliveryState: 'delivered',
  attemptCount: 1,
  errorCode: null,
  providerMessageId: '0100019a-000000',
  sentAt: new Date('2026-09-19T09:14:02.000Z'),
  terminalAt: new Date('2026-09-19T09:14:05.000Z'),
};

function campaignApp(): Express {
  const repos = {
    campaigns: {
      async list() {
        return { items: [CAMPAIGN_ROW], nextCursor: null };
      },
      async findById() {
        return CAMPAIGN_ROW;
      },
      async readCounters() {
        return COUNTERS_ROW;
      },
      async listRecipients() {
        return { items: [RECIPIENT_ROW], nextCursor: null };
      },
      async listEvents() {
        return [
          {
            id: 'e1',
            eventType: 'launch.queued',
            actorType: 'user' as const,
            actorId: USER,
            actorName: 'Farah Al-Mansoori',
            detail: { recipientCount: 1000, suppressedAtSnapshot: 12 },
            createdAt: new Date('2026-09-19T09:00:00.000Z'),
          },
        ];
      },
      async create() {
        return CAMPAIGN_ROW;
      },
      async update() {
        return CAMPAIGN_ROW;
      },
      async schedule() {
        return CAMPAIGN_ROW;
      },
      async clone() {
        return CAMPAIGN_ROW;
      },
      async archive() {
        return { ...CAMPAIGN_ROW, archivedAt: new Date('2026-09-20T00:00:00.000Z') };
      },
      async unarchive() {
        return CAMPAIGN_ROW;
      },
      async claimLaunchKey() {
        return 'claimed' as const;
      },
      async findLaunchByKey() {
        return null;
      },
      async enqueueTestSend() {
        return { queued: 1 };
      },
      async previewAudienceCount() {
        return { eligible: 900, suppressed: 100 };
      },
    } as unknown as CampaignRepositories['campaigns'],

    auditLogs: {
      async append() {
        /* nothing */
      },
    } as unknown as CampaignRepositories['auditLogs'],

    consent: {
      async record(_scope: unknown, input: unknown) {
        return input;
      },
      async newestFor() {
        return null;
      },
    } as unknown as CampaignRepositories['consent'],
  };

  /**
   * The launch port, every check passing.
   *
   * The real `runLaunchPreflight` runs against it, so the `checks` array on
   * `POST /preflight` is the engine's own rows rather than a literal this
   * file made up — which is the only way the assertion below means
   * anything.
   */
  const launchPort = {
    async claimForLaunch() {
      return true;
    },
    async readCampaign() {
      return {
        id: CAMPAIGN,
        workspaceId: WS,
        templateVersionId: 'v1' as TemplateVersionId,
        senderAccountId: 'sa-1',
        sendingPoolId: null,
        audience: {},
      };
    },
    async readEntitlementForShare() {
      return { monthlySendLimit: null, used: 0 };
    },
    async senderIsUsable() {
      return true;
    },
    async ownerEmailIsVerified() {
      return true;
    },
    async workspaceIsInRamp() {
      return false;
    },
    async readEnforcementStage() {
      return 'none' as const;
    },
    async launchIsApproved() {
      return true;
    },
    async scanContent() {
      return { blocked: false, findings: [], blockedDomains: [], reputationUnavailable: false };
    },
    async readConsentAttestation() {
      return {
        source: 'signup_form' as const,
        detail: null,
        // The real fingerprint of this campaign's audience. `null` is the
        // import-time attestation, which deliberately never authorises a
        // launch, so leaving it null makes every launch 422.
        audienceFingerprint: audienceFingerprint(CAMPAIGN_ROW.audience),
        attestedAt: new Date('2026-09-19T08:00:00.000Z'),
        attestedBy: USER,
      };
    },
    async snapshotAudience() {
      return { inserted: 1000, suppressedAtSnapshot: 12 };
    },
    async initialiseCounters() {
      /* nothing */
    },
    async markQueueing() {
      /* nothing */
    },
    async releaseClaim() {
      /* nothing */
    },
    async recordEvent() {
      /* nothing */
    },
  };

  const options: CampaignServiceOptions = {
    unitOfWork: (fn) => fn(repos),
    newId: () => 'generated-id',
    currentActor: () => ({ type: 'user', id: USER }),
    errorPolicy: { rate_limited: { retryable: true } },
    now: () => new Date('2026-09-19T12:00:00.000Z'),
    async enqueueDispatch() {
      /* nothing */
    },
    ports: {
      launch: () => launchPort as never,
      lifecycle: () =>
        ({
          async transition() {
            return 'pausing';
          },
          async setHaltFlag() {
            /* nothing */
          },
          async cancelOutstandingRecipients() {
            return 0;
          },
          async inFlightCount() {
            return 0;
          },
          async enqueueDispatch() {
            /* nothing */
          },
          async recordEvent() {
            /* nothing */
          },
        }) as never,
      retry: () =>
        ({
          async resetRetryableFailures() {
            return 12;
          },
          async countPermanentFailures() {
            return { invalid_recipient: 3 };
          },
          async reopenForDispatch() {
            return true;
          },
          async recordEvent() {
            /* nothing */
          },
        }) as never,
    },
  };

  // The real service, not a stub: `get` and `progress` are where the
  // counters are shaped, and a stubbed service would skip exactly that.
  return mount(campaignRoutes({ campaigns: new CampaignService(options), tokens, memberships }));
}

describe('campaigns', () => {
  it('GET /campaigns answers { items: Campaign[]; nextCursor: string | null }', async () => {
    const { data } = await call(campaignApp(), 'get', '/api/v1/campaigns');

    expectShape(data, { items: arrayOf(shaped(CAMPAIGN_SHAPE)), nextCursor: nullable(str) }, 'list');
    expectEachShape((data as { items: unknown }).items, CAMPAIGN_SHAPE, 'list.items');
  });

  it('GET /campaigns/:id answers { campaign; counters: CampaignProgress | null }', async () => {
    const { data } = await call(campaignApp(), 'get', `/api/v1/campaigns/${CAMPAIGN}`);

    expectShape(data, { campaign: isObject, counters: nullable(isObject) }, 'get');
    expectShape((data as { campaign: unknown }).campaign, CAMPAIGN_SHAPE, 'get.campaign');

    // The detail page does `progress.data ?? campaign.counters` into one
    // `CampaignProgress`, so the counters on this payload must be the same
    // shape `/progress` answers with — including the three derived fields.
    // Returning the bare counters row left the uncertain tile reading zero
    // on the first paint of a campaign that had some.
    expectShape((data as { counters: unknown }).counters, PROGRESS_SHAPE, 'get.counters');
  });

  it('GET /campaigns/:id/progress answers CampaignProgress', async () => {
    const { data } = await call(campaignApp(), 'get', `/api/v1/campaigns/${CAMPAIGN}/progress`);
    expectShape(data, PROGRESS_SHAPE, 'progress');
  });

  it('GET /campaigns/:id/recipients answers { items: Recipient[]; nextCursor }', async () => {
    const { data } = await call(campaignApp(), 'get', `/api/v1/campaigns/${CAMPAIGN}/recipients`);

    expectShape(data, { items: anything, nextCursor: nullable(str) }, 'recipients');
    expectEachShape(
      (data as { items: unknown }).items,
      {
        id: str,
        email: str,
        state: str,
        deliveryState: nullable(str),
        attemptCount: num,
        errorCode: nullable(str),
        sentAt: nullable(isoString),
        // Served, and therefore no longer a gap: G3's "Provider message ID"
        // column is a real column on `campaign_recipients`.
        providerMessageId: nullable(str),
      },
      'recipients.items',
    );
  });

  it('GET /campaigns/:id/timeline answers TimelineEvent[]', async () => {
    const { data } = await call(campaignApp(), 'get', `/api/v1/campaigns/${CAMPAIGN}/timeline`);

    expectEachShape(
      data,
      {
        id: str,
        title: str,
        // A rendered clock string in the campaign's zone, not an instant.
        time: str,
        detail: str,
        tone: oneOf('brand', 'success', 'warning', 'danger', 'neutral'),
        occurredAt: isoString,
      },
      'timeline',
    );
  });

  it('POST /campaigns/audience-preview answers { eligible; suppressed; total }', async () => {
    const { data } = await call(campaignApp(), 'post', '/api/v1/campaigns/audience-preview', {
      listIds: ['6f1d8b0e-0000-4000-8000-000000000001'],
    });

    expectShape(data, { eligible: num, suppressed: num, total: num }, 'audience-preview');
  });

  it.each([
    ['post', '/api/v1/campaigns', { name: 'Spring escapes' }, 201],
    ['patch', `/api/v1/campaigns/${CAMPAIGN}`, { name: 'Renamed' }, 200],
    ['post', `/api/v1/campaigns/${CAMPAIGN}/clone`, {}, 201],
    ['post', `/api/v1/campaigns/${CAMPAIGN}/archive`, {}, 200],
    ['post', `/api/v1/campaigns/${CAMPAIGN}/unarchive`, {}, 200],
  ] as const)('%s %s answers a Campaign', async (method, path, body, status) => {
    const response = await call(campaignApp(), method, path, body);

    expect(response.status, path).toBe(status);
    expectShape(response.data, CAMPAIGN_SHAPE, path);
  });

  it('POST /campaigns/:id/schedule answers a Campaign', async () => {
    const { data } = await call(campaignApp(), 'post', `/api/v1/campaigns/${CAMPAIGN}/schedule`, {
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      timezone: 'Asia/Dubai',
    });

    expectShape(data, CAMPAIGN_SHAPE, 'schedule');
  });

  it('POST /campaigns/:id/launch answers LaunchResult with 202', async () => {
    const response = await call(campaignApp(), 'post', `/api/v1/campaigns/${CAMPAIGN}/launch`, {
      consent: { source: 'signup_form' },
    });

    // 202, not 200: the snapshot is taken and nothing has been sent.
    expect(response.status).toBe(202);
    expectShape(response.data, { ok: bool }, 'launch');
  });

  it.each(['pause', 'resume', 'cancel'] as const)(
    'POST /campaigns/:id/%s answers { state }',
    async (action) => {
      const { data } = await call(campaignApp(), 'post', `/api/v1/campaigns/${CAMPAIGN}/${action}`);
      expectShape(data, { state: str }, action);
    },
  );

  it('POST /campaigns/:id/retry-failed answers { retried; excluded }', async () => {
    const { data } = await call(
      campaignApp(),
      'post',
      `/api/v1/campaigns/${CAMPAIGN}/retry-failed`,
    );

    expectShape(data, { retried: num, excluded: recordOf(num) }, 'retry-failed');
  });

  it('POST /campaigns/:id/test-send answers { queued }', async () => {
    const { data } = await call(campaignApp(), 'post', `/api/v1/campaigns/${CAMPAIGN}/test-send`, {
      to: ['qa@example.com'],
    });

    expectShape(data, { queued: num }, 'test-send');
  });

  it('POST /campaigns/:id/preflight answers PreflightResult', async () => {
    const { data } = await call(campaignApp(), 'post', `/api/v1/campaigns/${CAMPAIGN}/preflight`);

    expectShape(data, { ok: bool, failure: nullable(str), checks: anything }, 'preflight');
    expectEachShape(
      (data as { checks: unknown }).checks,
      {
        key: str,
        outcome: oneOf('pass', 'warn', 'fail'),
        title: str,
        detail: str,
        failure: nullable(str),
      },
      'preflight.checks',
    );
  });
});

/* -------------------------------------------------------------- templates -- */

const TEMPLATE_ROW = {
  id: 't1' as TemplateId,
  workspaceId: WS,
  name: 'Autumn escapes',
  category: null,
  currentVersionId: 'v1' as TemplateVersionId,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
  archived: false,
};

const VERSION_ROW = {
  id: 'v1' as TemplateVersionId,
  workspaceId: WS,
  templateId: 't1' as TemplateId,
  version: 1,
  subject: 'Hi {{first_name|"there"}}',
  preheader: null,
  htmlSource: '<p>hi</p>',
  htmlCompiled: '<p>hi</p>',
  textBody: 'hi',
  variables: [{ field: 'first_name', default: 'there', required: false }],
  publishedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
};

const TEMPLATE_SHAPE: Spec = {
  id: str,
  name: str,
  category: nullable(str),
  currentVersionId: nullable(str),
  createdAt: isoString,
  updatedAt: isoString,
  archived: bool,
};

const VERSION_SHAPE: Spec = {
  id: str,
  templateId: str,
  version: num,
  subject: str,
  preheader: nullable(str),
  htmlSource: str,
  htmlCompiled: str,
  textBody: str,
  variables: anything,
  publishedAt: nullable(isoString),
  createdAt: isoString,
};

function templateApp(): Express {
  const templates = {
    async list(): Promise<Awaited<ReturnType<TemplateService['list']>>> {
      return [TEMPLATE_ROW];
    },
    async get(): Promise<Awaited<ReturnType<TemplateService['get']>>> {
      return { template: TEMPLATE_ROW, versions: [VERSION_ROW] };
    },
    async create(): Promise<Awaited<ReturnType<TemplateService['create']>>> {
      return { template: TEMPLATE_ROW, version: VERSION_ROW, removed: ['<script>'] };
    },
    async rename(): Promise<Awaited<ReturnType<TemplateService['rename']>>> {
      return TEMPLATE_ROW;
    },
    async archive(): Promise<Awaited<ReturnType<TemplateService['archive']>>> {
      return { ...TEMPLATE_ROW, archived: true };
    },
    async unarchive(): Promise<Awaited<ReturnType<TemplateService['unarchive']>>> {
      return TEMPLATE_ROW;
    },
    async duplicate(): Promise<Awaited<ReturnType<TemplateService['duplicate']>>> {
      return TEMPLATE_ROW;
    },
    async saveVersion(): Promise<Awaited<ReturnType<TemplateService['saveVersion']>>> {
      return { version: VERSION_ROW, removed: [] };
    },
    async publish(): Promise<Awaited<ReturnType<TemplateService['publish']>>> {
      return { ...VERSION_ROW, publishedAt: new Date('2026-09-15T14:20:00.000Z') };
    },
    async sendTest(): Promise<Awaited<ReturnType<TemplateService['sendTest']>>> {
      return { accepted: true, jobId: 'job-1' };
    },
    async preview(): Promise<Awaited<ReturnType<TemplateService['preview']>>> {
      return {
        subject: 'Hi there',
        html: '<p>hi</p>',
        text: 'hi',
        templateVersionId: 'v1' as TemplateVersionId,
        version: 1,
        published: false,
      };
    },
  } as unknown as TemplateService;

  return mount(templateRoutes({ templates, tokens, memberships }));
}

describe('templates', () => {
  it('GET /templates answers Template[]', async () => {
    const { data } = await call(templateApp(), 'get', '/api/v1/templates');
    expectEachShape(data, TEMPLATE_SHAPE, 'templates');
  });

  it('GET /templates/:id answers { template; versions }', async () => {
    const { data } = await call(templateApp(), 'get', '/api/v1/templates/t1');

    expectShape(data, { template: isObject, versions: anything }, 'template detail');
    expectShape((data as { template: unknown }).template, TEMPLATE_SHAPE, 'detail.template');
    expectEachShape((data as { versions: unknown }).versions, VERSION_SHAPE, 'detail.versions');
  });

  it('POST /templates answers { template; version; removed }', async () => {
    const { status, data } = await call(templateApp(), 'post', '/api/v1/templates', {
      name: 'Autumn escapes',
      subject: 'Hi',
      html: '<p>hi</p>',
    });

    expect(status).toBe(201);
    expectShape(data, { template: isObject, version: isObject, removed: arrayOf(str) }, 'create');
    expectShape((data as { template: unknown }).template, TEMPLATE_SHAPE, 'create.template');
    expectShape((data as { version: unknown }).version, VERSION_SHAPE, 'create.version');
  });

  it.each([
    ['patch', '/api/v1/templates/t1', { name: 'Renamed' }],
    ['post', '/api/v1/templates/t1/archive', {}],
    ['post', '/api/v1/templates/t1/unarchive', {}],
    ['post', '/api/v1/templates/t1/duplicate', {}],
  ] as const)('%s %s answers a Template', async (method, path, body) => {
    const { data } = await call(templateApp(), method, path, body);
    expectShape(data, TEMPLATE_SHAPE, path);
  });

  it.each([
    ['post', '/api/v1/templates/t1/versions', { subject: 'Hi', html: '<p>hi</p>' }],
    ['post', '/api/v1/templates/versions/v1/publish', {}],
  ] as const)('%s %s answers a TemplateVersion', async (method, path, body) => {
    const { data } = await call(templateApp(), method, path, body);
    expectShape(data, VERSION_SHAPE, path);
  });

  it('POST /templates/versions/:id/test answers { accepted; jobId }', async () => {
    const { status, data } = await call(
      templateApp(),
      'post',
      '/api/v1/templates/versions/v1/test',
      { to: 'qa@example.com' },
    );

    // 202: queued, not delivered.
    expect(status).toBe(202);
    expectShape(data, { accepted: bool, jobId: str }, 'send test');
  });

  it('POST /templates/versions/:id/preview answers a Preview', async () => {
    const { data } = await call(
      templateApp(),
      'post',
      '/api/v1/templates/versions/v1/preview',
      { firstName: 'Amira' },
    );

    expectShape(
      data,
      {
        subject: str,
        html: str,
        text: str,
        templateVersionId: str,
        version: num,
        published: bool,
      },
      'preview',
    );
  });
});

/* ------------------------------------------------------ providers, senders -- */

const CONNECTION_VIEW = {
  id: 'pc1',
  providerType: 'ses' as const,
  name: 'Production SES',
  status: 'active' as const,
  hasWebhookSecret: true,
  lastVerifiedAt: new Date('2026-09-18T00:00:00.000Z'),
  lastError: null,
  quotaSnapshot: { max24Hour: 200_000, sentLast24Hours: 164_000, maxSendRate: 50 },
  capabilities: { supportsWebhooks: true, reportsQuota: true, maxBatchSize: 50 },
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
};

const CONNECTION_SHAPE: Spec = {
  id: str,
  providerType: str,
  name: str,
  status: str,
  hasWebhookSecret: bool,
  lastVerifiedAt: nullable(isoString),
  lastError: nullable(isObject),
  quotaSnapshot: nullable(isObject),
  capabilities: isObject,
  createdAt: isoString,
};

const SENDER_ROW = {
  id: 'sa1',
  workspaceId: WS,
  providerId: 'pc1',
  identityId: 'si1',
  fromEmail: 'hello@northwind.example',
  fromName: 'Northwind Voyages',
  replyTo: null,
  status: 'active' as const,
  dailyLimit: null,
  hourlyLimit: null,
  concurrencyLimit: 5,
  healthScore: 98,
  consecutiveFailures: 0,
  cooldownUntil: null,
  lastSendAt: new Date('2026-09-19T09:00:00.000Z'),
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-19T09:00:00.000Z'),
};

const SENDER_SHAPE: Spec = {
  id: str,
  providerId: str,
  identityId: str,
  fromEmail: str,
  fromName: str,
  replyTo: nullable(str),
  status: str,
  dailyLimit: nullable(num),
  hourlyLimit: nullable(num),
  healthScore: num,
  consecutiveFailures: num,
  cooldownUntil: nullable(isoString),
  lastSendAt: nullable(isoString),
};

const DNS_VIEW = {
  senderId: 'sa1',
  problem: null,
  records: [
    {
      kind: 'SPF' as const,
      purpose: 'authorises the server to send',
      status: 'verified' as const,
      type: 'TXT',
      host: 'northwind.example',
      value: 'v=spf1 include:amazonses.com ~all',
      found: 'v=spf1 include:amazonses.com ~all',
    },
  ],
  lastCheckedAt: '2026-09-19T09:00:00.000Z',
  nextCheckInMinutes: 15,
};

function providerApp(): Express {
  const providers = {
    async listConnections(): Promise<Awaited<ReturnType<ProviderService['listConnections']>>> {
      return [CONNECTION_VIEW];
    },
    async getConnection(): Promise<Awaited<ReturnType<ProviderService['getConnection']>>> {
      return CONNECTION_VIEW;
    },
    async connect(): Promise<Awaited<ReturnType<ProviderService['connect']>>> {
      return {
        connection: CONNECTION_VIEW,
        ingestUrl: 'https://ingest.relayd.test/ingest/v1/ses/tok',
        warnings: ['This SES account is in the sandbox'],
      };
    },
    async rename(): Promise<Awaited<ReturnType<ProviderService['rename']>>> {
      return CONNECTION_VIEW;
    },
    async verify(): Promise<Awaited<ReturnType<ProviderService['verify']>>> {
      return CONNECTION_VIEW;
    },
    async rotate(): Promise<Awaited<ReturnType<ProviderService['rotate']>>> {
      return CONNECTION_VIEW;
    },
    async sendIngestTestEvent(): Promise<
      Awaited<ReturnType<ProviderService['sendIngestTestEvent']>>
    > {
      return { sent: true };
    },
    async listIdentities(): Promise<Awaited<ReturnType<ProviderService['listIdentities']>>> {
      return [
        {
          id: 'si1',
          workspaceId: WS,
          providerId: 'pc1',
          kind: 'domain',
          value: 'northwind.example',
          verificationStatus: 'verified',
          dkimStatus: 'verified',
          spfStatus: 'verified',
          dmarcStatus: 'p=reject',
          dnsRecords: null,
          verifiedAt: new Date('2026-09-05T00:00:00.000Z'),
          lastCheckedAt: new Date('2026-09-19T09:00:00.000Z'),
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ] as Awaited<ReturnType<ProviderService['listIdentities']>>;
    },
    async syncIdentities(): Promise<Awaited<ReturnType<ProviderService['syncIdentities']>>> {
      return { synced: 3 };
    },
    async listSenders(): Promise<Awaited<ReturnType<ProviderService['listSenders']>>> {
      return [SENDER_ROW] as Awaited<ReturnType<ProviderService['listSenders']>>;
    },
    async createSender(): Promise<Awaited<ReturnType<ProviderService['createSender']>>> {
      return SENDER_ROW as Awaited<ReturnType<ProviderService['createSender']>>;
    },
    async updateSender(): Promise<Awaited<ReturnType<ProviderService['updateSender']>>> {
      return SENDER_ROW as Awaited<ReturnType<ProviderService['updateSender']>>;
    },
    async senderDns(): Promise<Awaited<ReturnType<ProviderService['senderDns']>>> {
      return DNS_VIEW;
    },
    async checkSenderDns(): Promise<Awaited<ReturnType<ProviderService['checkSenderDns']>>> {
      return DNS_VIEW;
    },
    async testSend(): Promise<Awaited<ReturnType<ProviderService['testSend']>>> {
      return { jobId: 'job-1', queued: 2 };
    },
  } as unknown as ProviderService;

  return mount(providerRoutes({ providers, tokens, memberships }));
}

const SES_CREDENTIALS = {
  type: 'ses' as const,
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'eu-west-1',
};

describe('providers and senders', () => {
  it('GET /providers answers Connection[]', async () => {
    const { data } = await call(providerApp(), 'get', '/api/v1/providers');
    expectEachShape(data, CONNECTION_SHAPE, 'connections');
  });

  it('GET /providers/:id answers a Connection', async () => {
    const { data } = await call(providerApp(), 'get', '/api/v1/providers/pc1');
    expectShape(data, CONNECTION_SHAPE, 'connection');
  });

  it('POST /providers answers a Connection plus ingestUrl and warnings', async () => {
    const { status, data } = await call(providerApp(), 'post', '/api/v1/providers', {
      providerType: 'ses',
      name: 'Production SES',
      credentials: SES_CREDENTIALS,
    });

    expect(status).toBe(201);

    // `ConnectResult extends Connection`: the ingest URL is shown once and
    // read back from nowhere, so it has to be on this response and correct.
    expectShape(
      data,
      { ...CONNECTION_SHAPE, ingestUrl: str, warnings: arrayOf(str) },
      'connect',
    );
  });

  it.each([
    ['patch', '/api/v1/providers/pc1', { name: 'Renamed' }],
    ['post', '/api/v1/providers/pc1/verify', { credentials: SES_CREDENTIALS }],
    ['post', '/api/v1/providers/pc1/rotate', { credentials: SES_CREDENTIALS }],
  ] as const)('%s %s answers a Connection', async (method, path, body) => {
    const { data } = await call(providerApp(), method, path, body);
    expectShape(data, CONNECTION_SHAPE, path);
  });

  it('POST /providers/:id/ingest/test answers { sent }', async () => {
    const { data } = await call(providerApp(), 'post', '/api/v1/providers/pc1/ingest/test');
    expectShape(data, { sent: bool }, 'ingest test');
  });

  it('GET /providers/:id/identities answers SenderIdentity[]', async () => {
    const { data } = await call(providerApp(), 'get', '/api/v1/providers/pc1/identities');

    expectEachShape(
      data,
      {
        id: str,
        providerId: str,
        kind: oneOf('domain', 'email'),
        value: str,
        verificationStatus: oneOf('pending', 'verified', 'failed', 'expired'),
        dkimStatus: nullable(str),
        spfStatus: nullable(str),
        dmarcStatus: nullable(str),
        verifiedAt: nullable(isoString),
      },
      'identities',
    );
  });

  it('POST /providers/:id/identities/sync answers { synced }', async () => {
    const { data } = await call(
      providerApp(),
      'post',
      '/api/v1/providers/pc1/identities/sync',
      { credentials: SES_CREDENTIALS },
    );

    expectShape(data, { synced: num }, 'sync');
  });

  it('GET /senders answers Sender[]', async () => {
    const { data } = await call(providerApp(), 'get', '/api/v1/senders');
    expectEachShape(data, SENDER_SHAPE, 'senders');
  });

  it('POST /senders answers a Sender', async () => {
    const { status, data } = await call(providerApp(), 'post', '/api/v1/senders', {
      providerId: '6f1d8b0e-0000-4000-8000-000000000001',
      identityId: '6f1d8b0e-0000-4000-8000-000000000002',
      fromEmail: 'hello@northwind.example',
      fromName: 'Northwind Voyages',
    });

    expect(status).toBe(201);
    expectShape(data, SENDER_SHAPE, 'create sender');
  });

  it('PATCH /senders/:id answers a Sender', async () => {
    const { data } = await call(providerApp(), 'patch', '/api/v1/senders/sa1', {
      fromName: 'Northwind',
    });

    expectShape(data, SENDER_SHAPE, 'update sender');
  });

  it.each([
    ['get', '/api/v1/senders/sa1/dns'],
    ['post', '/api/v1/senders/sa1/dns/check'],
  ] as const)('%s %s answers SenderDns', async (method, path) => {
    const { data } = await call(providerApp(), method, path);

    expectShape(
      data,
      {
        senderId: str,
        problem: nullable(isObject),
        records: anything,
        lastCheckedAt: isoString,
        nextCheckInMinutes: num,
      },
      path,
    );

    expectEachShape(
      (data as { records: unknown }).records,
      {
        kind: oneOf('SPF', 'DKIM', 'DMARC'),
        purpose: str,
        status: oneOf('verified', 'pending', 'failed'),
        type: str,
        host: str,
        value: str,
        found: str,
      },
      `${path}.records`,
    );
  });

  it('POST /senders/:id/test answers { jobId; queued }', async () => {
    const { data } = await call(providerApp(), 'post', '/api/v1/senders/sa1/test', {
      // The provider schema carries senderId in the body even though the
      // route takes it from the path; providerApi.testSend sends both.
      senderId: 'sa1',
      to: ['qa@example.com'],
    });

    expectShape(data, { jobId: str, queued: num }, 'sender test send');
  });
});

/* ------------------------------------------------------------------ pools -- */

const POOL_ROW = {
  id: 'sp1' as SendingPoolId,
  workspaceId: WS,
  name: 'EU marketing pool',
  strategy: 'round_robin' as const,
  isDefault: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-02T00:00:00.000Z'),
};

const POOL_MEMBER_ROW = {
  poolId: 'sp1' as SendingPoolId,
  senderAccountId: 'sa1',
  providerConnectionId: 'pc1',
  weight: 1,
  priority: 0,
  enabled: true,
  status: 'active',
  healthScore: 98,
  cooldownUntil: null,
};

const POOL_SHAPE: Spec = {
  id: str,
  name: str,
  strategy: str,
  isDefault: bool,
  createdAt: isoString,
  updatedAt: isoString,
};

const POOL_MEMBER_SHAPE: Spec = {
  poolId: str,
  senderAccountId: str,
  providerConnectionId: str,
  weight: num,
  priority: num,
  enabled: bool,
  status: str,
  healthScore: num,
  cooldownUntil: nullable(isoString),
};

function poolApp(): Express {
  const pools = {
    async list(): Promise<Awaited<ReturnType<PoolService['list']>>> {
      return [POOL_ROW];
    },
    async get(): Promise<Awaited<ReturnType<PoolService['get']>>> {
      return { pool: POOL_ROW, members: [POOL_MEMBER_ROW] };
    },
    async health(): Promise<Awaited<ReturnType<PoolService['health']>>> {
      return {
        pool: POOL_ROW,
        strategy: POOL_ROW.strategy,
        members: [
          { ...POOL_MEMBER_ROW, belowHealthFloor: false, sharesProviderAccount: true },
        ],
        healthyCount: 1,
        sharedProviderAccounts: ['pc1'],
        wouldHold: false,
      };
    },
    async eligibleSenders(): Promise<Awaited<ReturnType<PoolService['eligibleSenders']>>> {
      return [
        {
          id: 'sa1',
          email: 'hello@northwind.example',
          monogram: 'SES',
          providerConnectionId: 'pc1',
          connectionLabel: 'Production SES · eu-west-1',
          perSecond: 50,
          remainingToday: 36_000,
          blockedReason: null,
        },
      ];
    },
    async create(): Promise<Awaited<ReturnType<PoolService['create']>>> {
      return POOL_ROW;
    },
    async update(): Promise<Awaited<ReturnType<PoolService['update']>>> {
      return POOL_ROW;
    },
    async addMember(): Promise<Awaited<ReturnType<PoolService['addMember']>>> {
      return { members: [POOL_MEMBER_ROW], sharedProviderAccounts: ['pc1'] };
    },
  } as unknown as PoolService;

  return mount(poolRoutes({ pools, tokens, memberships }));
}

describe('sending pools', () => {
  it('GET /pools answers Pool[]', async () => {
    const { data } = await call(poolApp(), 'get', '/api/v1/pools');
    expectEachShape(data, POOL_SHAPE, 'pools');
  });

  it('GET /pools/senders answers EligibleSender[]', async () => {
    const { data } = await call(poolApp(), 'get', '/api/v1/pools/senders');

    expectEachShape(
      data,
      {
        id: str,
        email: str,
        monogram: str,
        providerConnectionId: str,
        connectionLabel: str,
        perSecond: num,
        remainingToday: num,
        // Null rather than absent, so the drawer's optional
        // `blockedReason?: string | null` never reads `undefined`.
        blockedReason: nullable(str),
      },
      'eligible senders',
    );
  });

  it('GET /pools/:id answers { pool; members }', async () => {
    const { data } = await call(poolApp(), 'get', '/api/v1/pools/sp1');

    expectShape(data, { pool: isObject, members: anything }, 'pool detail');
    expectShape((data as { pool: unknown }).pool, POOL_SHAPE, 'pool detail.pool');
    expectEachShape((data as { members: unknown }).members, POOL_MEMBER_SHAPE, 'detail.members');
  });

  it('GET /pools/:id/health answers PoolHealth', async () => {
    const { data } = await call(poolApp(), 'get', '/api/v1/pools/sp1/health');

    expectShape(
      data,
      {
        strategy: str,
        members: anything,
        healthyCount: num,
        sharedProviderAccounts: arrayOf(str),
        wouldHold: bool,
      },
      'pool health',
    );

    expectEachShape(
      (data as { members: unknown }).members,
      {
        senderAccountId: str,
        providerConnectionId: str,
        enabled: bool,
        status: str,
        healthScore: num,
        belowHealthFloor: bool,
        sharesProviderAccount: bool,
      },
      'pool health.members',
    );
  });

  it.each([
    ['post', '/api/v1/pools', { name: 'EU marketing pool' }],
    ['patch', '/api/v1/pools/sp1', { name: 'Renamed' }],
  ] as const)('%s %s answers a Pool', async (method, path, body) => {
    const { data } = await call(poolApp(), method, path, body);
    expectShape(data, POOL_SHAPE, path);
  });

  it('POST /pools/:id/members answers { members; sharedProviderAccounts }', async () => {
    // Not the membership row: the shared-quota warning is the reason this
    // response exists, and a client typed as one row would drop it.
    const { status, data } = await call(poolApp(), 'post', '/api/v1/pools/sp1/members', {
      senderAccountId: '6f1d8b0e-0000-4000-8000-000000000001',
      weight: 1,
      priority: 0,
    });

    expect(status).toBe(201);
    expectShape(data, { members: anything, sharedProviderAccounts: arrayOf(str) }, 'add member');
    expectEachShape((data as { members: unknown }).members, POOL_MEMBER_SHAPE, 'add.members');
  });
});

/* ----------------------------------------------------- outbound webhooks -- */

const ENDPOINT_VIEW = {
  id: 'wh1',
  url: 'https://hooks.northwind.example/relayd',
  events: ['campaign.completed'],
  status: 'active' as const,
  description: null,
  consecutiveFailures: 0,
  lastSuccessAt: new Date('2026-09-19T09:00:00.000Z'),
  lastFailureAt: null,
  disabledAt: null,
  disabledReason: null,
  secretRotatedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
};

const ENDPOINT_SHAPE: Spec = {
  id: str,
  url: str,
  events: arrayOf(str),
  status: oneOf('active', 'paused', 'failing', 'disabled'),
  description: nullable(str),
  consecutiveFailures: num,
  lastSuccessAt: nullable(isoString),
  lastFailureAt: nullable(isoString),
  disabledAt: nullable(isoString),
  disabledReason: nullable(str),
  secretRotatedAt: nullable(isoString),
  createdAt: isoString,
};

function webhookApp(): Express {
  const webhooks = {
    eventTypes(): readonly string[] {
      return ['campaign.completed', 'recipient.bounced'];
    },
    async list(): Promise<Awaited<ReturnType<OutboundWebhookService['list']>>> {
      return [ENDPOINT_VIEW];
    },
    async create(): Promise<Awaited<ReturnType<OutboundWebhookService['create']>>> {
      return { endpoint: ENDPOINT_VIEW, secretShownOnce: 'whsec_abc' };
    },
    async update(): Promise<Awaited<ReturnType<OutboundWebhookService['update']>>> {
      return ENDPOINT_VIEW;
    },
    async rotateSecret(): Promise<Awaited<ReturnType<OutboundWebhookService['rotateSecret']>>> {
      return { endpoint: ENDPOINT_VIEW, secretShownOnce: 'whsec_def' };
    },
    async sendTest(): Promise<Awaited<ReturnType<OutboundWebhookService['sendTest']>>> {
      return { sent: true };
    },
    async replay(): Promise<Awaited<ReturnType<OutboundWebhookService['replay']>>> {
      return { replaying: 4 };
    },
    async deliveries(): Promise<Awaited<ReturnType<OutboundWebhookService['deliveries']>>> {
      return [
        {
          id: 1,
          endpointId: 'wh1',
          eventType: 'campaign.completed',
          eventId: 'evt_1',
          attempt: 1,
          status: 'delivered',
          responseCode: 200,
          responseBody: 'ok',
          error: null,
          durationMs: 132,
          scheduledFor: new Date('2026-09-19T09:00:00.000Z'),
          deliveredAt: new Date('2026-09-19T09:00:01.000Z'),
          createdAt: new Date('2026-09-19T09:00:00.000Z'),
        },
      ];
    },
  } as unknown as OutboundWebhookService;

  return mount(outboundWebhookRoutes({ webhooks, tokens, memberships }));
}

describe('outbound webhook endpoints', () => {
  it('GET /webhook-endpoints answers WebhookEndpoint[]', async () => {
    const { data } = await call(webhookApp(), 'get', '/api/v1/webhook-endpoints');
    expectEachShape(data, ENDPOINT_SHAPE, 'endpoints');
  });

  it('GET /webhook-endpoints/event-types answers { eventTypes }', async () => {
    const { data } = await call(webhookApp(), 'get', '/api/v1/webhook-endpoints/event-types');
    expectShape(data, { eventTypes: arrayOf(str) }, 'event types');
  });

  it('POST /webhook-endpoints answers the endpoint plus its one-time secret', async () => {
    const { status, data } = await call(webhookApp(), 'post', '/api/v1/webhook-endpoints', {
      url: 'https://hooks.northwind.example/relayd',
      events: ['campaign.completed'],
    });

    expect(status).toBe(201);
    expectShape(data, { ...ENDPOINT_SHAPE, secretShownOnce: str }, 'create endpoint');
  });

  it('POST /webhook-endpoints/:id/rotate-secret answers the same', async () => {
    const { data } = await call(
      webhookApp(),
      'post',
      '/api/v1/webhook-endpoints/wh1/rotate-secret',
      {},
    );

    expectShape(data, { ...ENDPOINT_SHAPE, secretShownOnce: str }, 'rotate secret');
  });

  it('PATCH /webhook-endpoints/:id answers a WebhookEndpoint', async () => {
    const { data } = await call(webhookApp(), 'patch', '/api/v1/webhook-endpoints/wh1', {
      status: 'paused',
    });

    expectShape(data, ENDPOINT_SHAPE, 'update endpoint');
  });

  it('POST /webhook-endpoints/:id/test answers { sent }', async () => {
    const { data } = await call(webhookApp(), 'post', '/api/v1/webhook-endpoints/wh1/test', {});
    expectShape(data, { sent: bool }, 'endpoint test');
  });

  it('POST /webhook-endpoints/:id/replay answers { replaying }', async () => {
    const { data } = await call(webhookApp(), 'post', '/api/v1/webhook-endpoints/wh1/replay', {});
    expectShape(data, { replaying: num }, 'replay');
  });

  it('GET /webhook-endpoints/:id/deliveries answers WebhookDelivery[]', async () => {
    // A bare array today. `webhookEndpointsApi.deliveries` normalises both
    // that and the `{ deliveries, total }` J4c wants, so either is a valid
    // contract — what must hold is the row.
    const { data } = await call(webhookApp(), 'get', '/api/v1/webhook-endpoints/wh1/deliveries');

    expectEachShape(
      data,
      {
        id: num,
        eventType: str,
        eventId: str,
        attempt: num,
        status: oneOf('pending', 'delivered', 'failed', 'abandoned'),
        responseCode: nullable(num),
        responseBody: nullable(str),
        error: nullable(str),
        durationMs: nullable(num),
        scheduledFor: isoString,
        deliveredAt: nullable(isoString),
        createdAt: isoString,
      },
      'deliveries',
    );
  });
});

/* ---------------------------------------------------------------- billing -- */

const PERIOD_END = new Date('2026-10-01T00:00:00.000Z');

function billingApp(over: Partial<BillingRepositoryLike> = {}): Express {
  const repo: BillingRepositoryLike = {
    async readEntitlements() {
      return [{ featureKey: FEATURES.emailsSent, limitValue: 100_000, flagValue: null }];
    },
    async readBillingState() {
      return {
        workspaceSuspended: false,
        subscriptionSuspended: false,
        pastDue: false,
        hasSubscription: true,
      };
    },
    async currentSubscription() {
      return {
        id: 'sub-row',
        providerSubscriptionId: 'sub_stripe',
        planCode: PLANS.growth,
        interval: 'month',
        status: 'active',
        currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
        scheduledPlanCode: null,
        scheduledChangeAt: null,
        trialEnd: null,
      };
    },
    async usageForPeriod() {
      return [
        { featureKey: FEATURES.emailsSent, used: 40_000, included: 100_000, periodEnd: PERIOD_END },
      ];
    },
    async currentUsageByFeature() {
      return { [FEATURES.contactsStored]: 48_210 };
    },
    async listInvoices() {
      return [
        {
          id: 'in_1',
          number: 'RLY-0042',
          status: 'paid',
          currency: 'usd',
          total: 9900,
          amountDue: 0,
          periodStart: new Date('2026-09-01T00:00:00.000Z'),
          periodEnd: PERIOD_END,
          paidAt: new Date('2026-09-01T00:05:00.000Z'),
          hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
          pdfUrl: 'https://invoice.stripe.com/i/1.pdf',
          createdAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ];
    },
    async defaultPaymentMethod() {
      return { brand: 'visa', last4: '4242', expMonth: 4, expYear: 2030 };
    },
    async providerCustomerId() {
      return 'cus_123';
    },
    async billingEmail() {
      return 'owner@northwind.example';
    },
    async billingDetails() {
      return null;
    },
    async saveBillingDetails(_scope, input) {
      return {
        email: input.email,
        company: input.company,
        address: input.address,
        taxId: input.taxId,
      };
    },
    ...over,
  };

  const options: BillingServiceOptions = {
    unitOfWork: async (fn) => fn({ billing: repo }),
    provider: {
      async createPortalSession() {
        return { url: 'https://billing.stripe.com/p/1' };
      },
      async createCheckoutSession() {
        return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', expiresAt: PERIOD_END };
      },
      async createCustomer() {
        return { id: 'cus_123', email: 'owner@northwind.example', deleted: false };
      },
      async updateSubscriptionPrice() {
        return {};
      },
      async cancelSubscription() {
        return {};
      },
      async resumeSubscription() {
        /* nothing */
      },
      async payInvoice() {
        /* nothing */
      },
    } as never,
    checkoutPort: () => ({
      async activeSubscription() {
        return null;
      },
      async findBillingCustomer() {
        return { id: 'bc-1', providerCustomerId: 'cus_123', status: 'active' as const };
      },
      async createPendingBillingCustomer() {
        /* nothing */
      },
      async attachProviderCustomer() {
        /* nothing */
      },
      async markBillingCustomerFailed() {
        /* nothing */
      },
      async findPrice() {
        return { id: 'price-row', providerPriceId: 'price_123' };
      },
      async recordEvent() {
        /* nothing */
      },
    }),
    planChangePort: () => ({
      async currentSubscription() {
        return {
          id: 'sub-row',
          providerSubscriptionId: 'sub_stripe',
          planCode: PLANS.growth,
          interval: 'month' as const,
          status: 'active',
          currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: false,
          scheduledPlanCode: null,
          scheduledChangeAt: null,
          trialEnd: null,
        };
      },
      async findPrice() {
        return { id: 'price-row', providerPriceId: 'price_business' };
      },
      async currentUsage() {
        return {};
      },
      async applyPlanNow() {
        /* nothing */
      },
      async schedulePlanChange() {
        /* nothing */
      },
      async recordEvent() {
        /* nothing */
      },
    }),
    newId: () => 'bc-new',
    appUrl: 'https://app.relayd.test',
    exports: {
      async enqueue() {
        return { jobId: 'job-1' };
      },
    },
  };

  return mount(billingRoutes({ billing: new BillingService(options), tokens, memberships }));
}

describe('billing', () => {
  it('GET /billing/plans answers PlanSummary[]', async () => {
    const { data } = await call(billingApp(), 'get', '/api/v1/billing/plans');

    expectEachShape(
      data,
      {
        code: str,
        name: str,
        rank: num,
        trialDays: num,
        limits: recordOf(nullable(num)),
        flags: recordOf(bool),
      },
      'plans',
    );
  });

  it('GET /billing answers a BillingOverview', async () => {
    // The page this drives is about money, so an absent field here is worse
    // than an error: it renders as an em dash or an empty form and the
    // customer concludes the product forgot what they typed.
    const { data } = await call(billingApp(), 'get', '/api/v1/billing');

    expectShape(
      data,
      {
        subscription: nullable(isObject),
        state: isObject,
        usage: anything,
        paymentMethod: nullable(isObject),
        // I8's form seeds itself from this. Before it was on the payload a
        // customer who had saved their VAT id came back to empty inputs.
        billingDetails: nullable(isObject),
      },
      'overview',
    );

    expectShape(
      (data as { subscription: unknown }).subscription,
      {
        planCode: str,
        planName: str,
        interval: oneOf('month', 'year'),
        status: str,
        currentPeriodStart: isoString,
        currentPeriodEnd: isoString,
        cancelAtPeriodEnd: bool,
        scheduledPlanCode: nullable(str),
        scheduledChangeAt: nullable(isoString),
        trialEnd: nullable(isoString),
      },
      'overview.subscription',
    );

    expectShape(
      (data as { state: unknown }).state,
      {
        workspaceSuspended: bool,
        subscriptionSuspended: bool,
        pastDue: bool,
        hasSubscription: bool,
      },
      'overview.state',
    );

    expectShape(
      (data as { paymentMethod: unknown }).paymentMethod,
      { brand: nullable(str), last4: nullable(str), expMonth: nullable(num), expYear: nullable(num) },
      'overview.paymentMethod',
    );

    expectShape(
      (data as { billingDetails: unknown }).billingDetails,
      { email: str, company: str, address: str, taxId: str },
      'overview.billingDetails',
    );
  });

  it('GET /billing carries the details a customer has saved', async () => {
    const { data } = await call(
      billingApp({
        async billingDetails() {
          return {
            email: 'finance@northwind.example',
            company: 'Northwind Voyages LLC',
            address: 'Dubai',
            taxId: 'AE123456789',
          };
        },
      }),
      'get',
      '/api/v1/billing',
    );

    expect((data as { billingDetails: { taxId: string } }).billingDetails.taxId).toBe(
      'AE123456789',
    );
  });

  it.each([
    ['/api/v1/billing', 'usage'],
    ['/api/v1/billing/usage', null],
  ] as const)('the usage rows on %s answer UsageRow', async (path, key) => {
    const { data } = await call(billingApp(), 'get', path);
    const rows = key === null ? data : (data as Record<string, unknown>)[key];

    expectEachShape(
      rows,
      { featureKey: str, used: num, included: nullable(num), overage: num, periodEnd: isoString },
      `${path} usage`,
    );
  });

  it('GET /billing/invoices answers InvoiceRow[]', async () => {
    const { data } = await call(billingApp(), 'get', '/api/v1/billing/invoices');

    expectEachShape(
      data,
      {
        id: str,
        number: nullable(str),
        status: str,
        currency: str,
        total: num,
        amountDue: num,
        periodStart: nullable(isoString),
        periodEnd: nullable(isoString),
        paidAt: nullable(isoString),
        hostedInvoiceUrl: nullable(str),
        pdfUrl: nullable(str),
        createdAt: isoString,
      },
      'invoices',
    );
  });

  it('GET /billing/checkout/status answers CheckoutStatus', async () => {
    const { data } = await call(
      billingApp(),
      'get',
      '/api/v1/billing/checkout/status?elapsedMs=2000',
    );

    expectShape(data, { ready: bool, action: oneOf('poll', 'fallback', 'give_up', 'done') }, 'checkout status');
  });

  it('GET /billing/plan-change/preview answers PlanChangePreview', async () => {
    const { data } = await call(
      billingApp(),
      'get',
      `/api/v1/billing/plan-change/preview?planCode=${PLANS.starter}`,
    );

    expectShape(
      data,
      { from: nullable(str), to: str, blocked: bool, conflicts: anything },
      'plan change preview',
    );
  });

  it('POST /billing/checkout answers { id; url; expiresAt }', async () => {
    const { status, data } = await call(billingApp(), 'post', '/api/v1/billing/checkout', {
      planCode: PLANS.business,
      interval: 'month',
    });

    expect(status).toBe(201);
    expectShape(data, { id: str, url: str, expiresAt: isoString }, 'checkout');
  });

  it('POST /billing/portal answers { url }', async () => {
    const { data } = await call(billingApp(), 'post', '/api/v1/billing/portal', {});
    expectShape(data, { url: str }, 'portal');
  });

  it('POST /billing/plan answers { direction; appliesAt; effectiveAt }', async () => {
    const { data } = await call(billingApp(), 'post', '/api/v1/billing/plan', {
      planCode: PLANS.business,
      interval: 'month',
    });

    expectShape(
      data,
      {
        direction: oneOf('upgrade', 'downgrade', 'interval_only', 'none'),
        appliesAt: oneOf('immediately', 'period_end'),
        effectiveAt: nullable(isoString),
      },
      'plan change',
    );
  });

  it('POST /billing/cancel answers { endsAt }', async () => {
    const { data } = await call(billingApp(), 'post', '/api/v1/billing/cancel', {
      immediately: false,
    });

    expectShape(data, { endsAt: nullable(isoString) }, 'cancel');
  });

  it('POST /billing/export answers { ok }', async () => {
    const { data } = await call(billingApp(), 'post', '/api/v1/billing/export', {});
    expectShape(data, { ok: bool }, 'export');
  });

  it('POST /billing/reactivate answers { ok }', async () => {
    // Only meaningful on a subscription that is scheduled to cancel; the
    // default fixture is a healthy one, and the endpoint rightly 409s it.
    const app = billingApp({
      async currentSubscription() {
        return {
          id: 'sub-row',
          providerSubscriptionId: 'sub_stripe',
          planCode: PLANS.growth,
          interval: 'month',
          status: 'active',
          currentPeriodStart: new Date('2026-09-01T00:00:00.000Z'),
          currentPeriodEnd: PERIOD_END,
          cancelAtPeriodEnd: true,
          scheduledPlanCode: null,
          scheduledChangeAt: null,
          trialEnd: null,
        };
      },
    } as Partial<BillingRepositoryLike>);

    const { data } = await call(app, 'post', '/api/v1/billing/reactivate', {});
    expectShape(data, { ok: bool }, 'reactivate');
  });

  it('POST /billing/retry-payment answers { ok }', async () => {
    // Needs an invoice in one of the unpaid statuses to retry.
    const app = billingApp({
      async listInvoices() {
        return [
          {
            id: 'in_1',
            number: 'RLY-0042',
            status: 'open',
            currency: 'usd',
            total: 9900,
            amountDue: 9900,
            periodStart: new Date('2026-09-01T00:00:00.000Z'),
            periodEnd: PERIOD_END,
            paidAt: null,
            hostedInvoiceUrl: 'https://invoice.stripe.com/i/1',
            pdfUrl: 'https://invoice.stripe.com/i/1.pdf',
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
          },
        ];
      },
    } as Partial<BillingRepositoryLike>);

    const { data } = await call(app, 'post', '/api/v1/billing/retry-payment', {});
    expectShape(data, { ok: bool }, 'retry-payment');
  });

  it('PATCH /billing/details answers the saved BillingDetails', async () => {
    const { data } = await call(billingApp(), 'patch', '/api/v1/billing/details', {
      email: 'finance@northwind.example',
      company: 'Northwind Voyages LLC',
      address: 'Dubai',
      taxId: 'AE123456789',
    });

    expectShape(data, { email: str, company: str, address: str, taxId: str }, 'save details');
  });
});

/* -------------------------------------------------------------- analytics -- */

const RATE_SHAPE: Spec = {
  kind: oneOf('click', 'open', 'bounce', 'complaint', 'unsubscribe', 'delivery'),
  numerator: num,
  denominator: num,
  // Null when there is nothing to divide by — never zero, which means 0%.
  value: nullable(num),
  confidence: oneOf('reliable', 'directional'),
  // Always present, on every rate: it is the number that answers "why is
  // this lower than my old tool".
  botFiltered: num,
};

const DAY_POINT_SHAPE: Spec = {
  day: str,
  sent: num,
  delivered: num,
  bounced: num,
  complained: num,
  opensUniqueNonbot: num,
  clicksUnique: num,
  unsubscribed: num,
};

const DAY_POINT = {
  day: '2026-09-19',
  sent: 48_213,
  delivered: 47_401,
  bounced: 640,
  complained: 12,
  opensUniqueNonbot: 18_204,
  clicksUnique: 4_112,
  unsubscribed: 38,
};

function rate(kind: string) {
  return {
    kind,
    numerator: 4_112,
    denominator: 47_401,
    value: 4_112 / 47_401,
    confidence: 'reliable',
    botFiltered: 310,
  };
}

function analyticsApp(): Express {
  const analytics = {
    async dashboard(): Promise<Awaited<ReturnType<AnalyticsService['dashboard']>>> {
      return {
        period: { label: '1–19 Sep 2026', timezone: 'Asia/Dubai', comparedTo: 'Aug' },
        usage: {
          sent: 148_204,
          limit: 200_000,
          renewsLabel: '74% · renews 1 Oct (12 days)',
          renewsShort: 'Renews 1 Oct',
          uncertain: 142,
        },
        deltas: { click: 0.8, open: null },
        bounceSplit: { soft: 0.004, hard: 0.002 },
        complaintThreshold: 0.003,
        providers: [
          {
            connectionId: 'pc1',
            code: 'SES',
            name: 'Amazon SES',
            label: 'eu-west-1 · production',
            health: 'healthy',
            sentToday: 12_400,
            dailyLimit: 200_000,
          },
        ],
        campaigns: [
          {
            id: 'c1',
            name: 'Spring escapes',
            state: 'sending',
            when: 'Started today, 09:00',
            recipients: 48_213,
            counts: { delivered: 31_618, pending: 16_000, uncertain: 12 },
            clickRate: 0.087,
          },
        ],
        attention: [
          {
            id: 'a1',
            tone: 'warning',
            title: 'Complaint rate rising',
            detail: '0.24% over the last 7 days',
            action: { label: 'Review', href: '/analytics/reports' },
          },
        ],
        suppressions: { applied: 812, note: '812 suppressed at launch' },
      };
    },
    async overview(): Promise<Awaited<ReturnType<AnalyticsService['overview']>>> {
      const { day: _day, ...totals } = DAY_POINT;

      return {
        from: '2026-09-01',
        to: '2026-09-19',
        points: [DAY_POINT],
        totals,
        rates: {
          click: rate('click'),
          open: rate('open'),
          bounce: rate('bounce'),
          complaint: rate('complaint'),
        },
        headline: 'click',
      } as Awaited<ReturnType<AnalyticsService['overview']>>;
    },
    async campaign(): Promise<Awaited<ReturnType<AnalyticsService['campaign']>>> {
      return {
        campaignId: CAMPAIGN,
        counts: {
          campaignId: CAMPAIGN,
          workspaceId: WS,
          recipients: 48_213,
          sent: 48_000,
          failed: 213,
          suppressed: 812,
          deliveryUncertain: 12,
          delivered: 47_401,
          bouncedHard: 220,
          bouncedSoft: 420,
          complained: 12,
          unsubscribed: 38,
          opensTotal: 24_100,
          opensUnique: 18_900,
          opensUniqueNonbot: 18_204,
          clicksTotal: 5_400,
          clicksUnique: 4_300,
          clicksUniqueNonbot: 4_112,
          computedAt: new Date('2026-09-19T12:00:00.000Z'),
          computedBy: 'hourly',
        },
        rates: {
          click: rate('click'),
          open: rate('open'),
          bounce: rate('bounce'),
          complaint: rate('complaint'),
          unsubscribe: rate('unsubscribe'),
          delivery: rate('delivery'),
        },
        headline: 'click',
        computedAt: new Date('2026-09-19T12:00:00.000Z'),
        computedBy: 'hourly',
      } as Awaited<ReturnType<AnalyticsService['campaign']>>;
    },
    async campaignTimeseries(): Promise<
      Awaited<ReturnType<AnalyticsService['campaignTimeseries']>>
    > {
      return { campaignId: CAMPAIGN, from: '2026-09-01', to: '2026-09-19', points: [DAY_POINT] };
    },
    async campaignProviders(): Promise<
      Awaited<ReturnType<AnalyticsService['campaignProviders']>>
    > {
      return {
        poolLabel: 'EU marketing pool',
        routing: 'round-robin',
        providers: [
          {
            connectionId: 'pc1',
            code: 'SES',
            name: 'Amazon SES',
            delivered: 31_618,
            bounceRate: 0.013,
            clickRate: null,
            uncertain: 12,
          },
        ],
        note: '12 sends are delivery uncertain',
      };
    },
    async campaignLinks(): Promise<Awaited<ReturnType<AnalyticsService['campaignLinks']>>> {
      return {
        campaignId: CAMPAIGN,
        links: [
          {
            linkId: 'l1',
            url: 'https://northwind.example/autumn',
            position: 1,
            clicksTotal: 2_100,
            clicksUnique: 1_800,
            clicksUniqueNonbot: 1_740,
            clickRate: rate('click'),
          },
        ],
      } as Awaited<ReturnType<AnalyticsService['campaignLinks']>>;
    },
    async campaignDevices(): Promise<Awaited<ReturnType<AnalyticsService['campaignDevices']>>> {
      return {
        campaignId: CAMPAIGN,
        total: 18_204,
        breakdown: [
          {
            deviceType: 'mobile',
            clientFamily: 'Apple Mail',
            opens: 12_000,
            clicks: 2_400,
            share: 0.66,
            isUnknown: false,
          },
        ],
        unknownShare: 0.12,
      } as Awaited<ReturnType<AnalyticsService['campaignDevices']>>;
    },
    async providers(): Promise<Awaited<ReturnType<AnalyticsService['providers']>>> {
      return {
        from: '2026-09-01',
        to: '2026-09-19',
        providers: [
          {
            providerConnectionId: 'pc1',
            sent: 48_000,
            delivered: 47_401,
            bouncedHard: 220,
            complained: 12,
            deliveryRate: rate('delivery'),
            bounceRate: rate('bounce'),
            complaintRate: rate('complaint'),
          },
        ],
      } as Awaited<ReturnType<AnalyticsService['providers']>>;
    },
  } as unknown as AnalyticsService;

  return mount(analyticsRoutes({ analytics, tokens, memberships }));
}

describe('analytics', () => {
  it('GET /analytics/dashboard answers DashboardSummary', async () => {
    const { data } = await call(analyticsApp(), 'get', '/api/v1/analytics/dashboard');

    expectShape(
      data,
      {
        period: shaped({ label: str, timezone: str, comparedTo: str }),
        usage: shaped({
          sent: num,
          limit: num,
          renewsLabel: str,
          renewsShort: str,
          uncertain: num,
        }),
        deltas: shaped({ click: nullable(num), open: nullable(num) }),
        bounceSplit: nullable(shaped({ soft: num, hard: num })),
        complaintThreshold: num,
        providers: anything,
        campaigns: anything,
        attention: anything,
        suppressions: nullable(shaped({ applied: num, note: str })),
      },
      'dashboard',
    );

    expectEachShape(
      (data as { providers: unknown }).providers,
      {
        connectionId: str,
        code: str,
        name: str,
        label: str,
        health: oneOf('healthy', 'degraded', 'failed'),
        sentToday: num,
        dailyLimit: nullable(num),
      },
      'dashboard.providers',
    );

    expectEachShape(
      (data as { campaigns: unknown }).campaigns,
      {
        id: str,
        name: str,
        state: str,
        when: str,
        recipients: nullable(num),
        counts: isObject,
        // Null before anything has been delivered — never zero, which the
        // row would render as "0.0%" on a campaign nobody has received yet.
        clickRate: nullable(num),
      },
      'dashboard.campaigns',
    );

    expectEachShape(
      (data as { attention: unknown }).attention,
      {
        id: str,
        tone: oneOf('danger', 'warning', 'info'),
        title: str,
        detail: str,
        action: nullable(shaped({ label: str, href: str })),
      },
      'dashboard.attention',
    );
  });

  it('GET /analytics/overview answers Overview', async () => {
    const { data } = await call(analyticsApp(), 'get', '/api/v1/analytics/overview');

    expectShape(
      data,
      {
        from: str,
        to: str,
        points: anything,
        totals: isObject,
        rates: shaped({
          click: shaped(RATE_SHAPE),
          open: shaped(RATE_SHAPE),
          bounce: shaped(RATE_SHAPE),
          complaint: shaped(RATE_SHAPE),
        }),
        headline: str,
      },
      'overview',
    );

    expectEachShape((data as { points: unknown }).points, DAY_POINT_SHAPE, 'overview.points');

    const { day: _day, ...totalsShape } = DAY_POINT_SHAPE;
    expectShape((data as { totals: unknown }).totals, totalsShape, 'overview.totals');
  });

  it('GET /analytics/campaigns/:id answers CampaignAnalytics', async () => {
    const { data } = await call(analyticsApp(), 'get', `/api/v1/analytics/campaigns/${CAMPAIGN}`);

    expectShape(
      data,
      {
        campaignId: str,
        counts: isObject,
        rates: isObject,
        headline: str,
        computedAt: isoString,
        computedBy: oneOf('incremental', 'hourly'),
      },
      'campaign analytics',
    );

    // Every one of the sixteen counts the report's tiles read. A missing one
    // renders as "undefined" in a stat tile rather than as a zero.
    expectShape(
      (data as { counts: unknown }).counts,
      Object.fromEntries(
        [
          'recipients',
          'sent',
          'failed',
          'suppressed',
          'deliveryUncertain',
          'delivered',
          'bouncedHard',
          'bouncedSoft',
          'complained',
          'unsubscribed',
          'opensTotal',
          'opensUnique',
          'opensUniqueNonbot',
          'clicksTotal',
          'clicksUnique',
          'clicksUniqueNonbot',
        ].map((key) => [key, num]),
      ),
      'campaign analytics.counts',
    );

    for (const kind of ['click', 'open', 'bounce', 'complaint', 'unsubscribe', 'delivery']) {
      expectShape(
        (data as { rates: Record<string, unknown> }).rates[kind],
        RATE_SHAPE,
        `campaign analytics.rates.${kind}`,
      );
    }
  });

  it('GET /analytics/campaigns/:id/timeseries answers { from; to; points }', async () => {
    const { data } = await call(
      analyticsApp(),
      'get',
      `/api/v1/analytics/campaigns/${CAMPAIGN}/timeseries`,
    );

    expectShape(data, { from: str, to: str, points: anything }, 'timeseries');
    expectEachShape((data as { points: unknown }).points, DAY_POINT_SHAPE, 'timeseries.points');
  });

  it('GET /analytics/campaigns/:id/providers answers CampaignProviderBreakdown', async () => {
    const { data } = await call(
      analyticsApp(),
      'get',
      `/api/v1/analytics/campaigns/${CAMPAIGN}/providers`,
    );

    expectShape(
      data,
      { poolLabel: nullable(str), routing: nullable(str), providers: anything, note: nullable(str) },
      'campaign providers',
    );

    expectEachShape(
      (data as { providers: unknown }).providers,
      {
        connectionId: str,
        code: str,
        name: str,
        delivered: num,
        bounceRate: nullable(num),
        clickRate: nullable(num),
        uncertain: num,
      },
      'campaign providers.providers',
    );
  });

  it('GET /analytics/campaigns/:id/links answers { links }', async () => {
    const { data } = await call(
      analyticsApp(),
      'get',
      `/api/v1/analytics/campaigns/${CAMPAIGN}/links`,
    );

    expectShape(data, { links: anything }, 'links');
    expectEachShape(
      (data as { links: unknown }).links,
      {
        linkId: str,
        url: str,
        position: num,
        clicksTotal: num,
        clicksUnique: num,
        clicksUniqueNonbot: num,
        clickRate: shaped(RATE_SHAPE),
      },
      'links.links',
    );
  });

  it('GET /analytics/campaigns/:id/devices answers DeviceBreakdown', async () => {
    const { data } = await call(
      analyticsApp(),
      'get',
      `/api/v1/analytics/campaigns/${CAMPAIGN}/devices`,
    );

    expectShape(
      data,
      { total: num, breakdown: anything, unknownShare: nullable(num) },
      'devices',
    );

    expectEachShape(
      (data as { breakdown: unknown }).breakdown,
      {
        deviceType: str,
        clientFamily: str,
        opens: num,
        clicks: num,
        share: nullable(num),
        isUnknown: bool,
      },
      'devices.breakdown',
    );
  });

  it('GET /analytics/providers answers ProviderBreakdown', async () => {
    const { data } = await call(analyticsApp(), 'get', '/api/v1/analytics/providers');

    expectShape(data, { from: str, to: str, providers: anything }, 'provider breakdown');
    expectEachShape(
      (data as { providers: unknown }).providers,
      {
        providerConnectionId: str,
        sent: num,
        delivered: num,
        bouncedHard: num,
        complained: num,
        deliveryRate: shaped(RATE_SHAPE),
        bounceRate: shaped(RATE_SHAPE),
        complaintRate: shaped(RATE_SHAPE),
      },
      'provider breakdown.providers',
    );
  });
});

/* ---------------------------------------------------------------- guards -- */

describe('the envelope itself', () => {
  it('wraps every answer in `data`, which is what the client unwraps', async () => {
    const response = await request(campaignApp())
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', WS);

    expect(Object.keys(response.body as object)).toContain('data');
  });

  it('gives a non-member 404 for another workspace, never 403', async () => {
    // Shapes are only half a contract: a client that gets 403 where it
    // expects 404 learns the workspace exists.
    const response = await request(campaignApp())
      .get('/api/v1/campaigns')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', 'ws-somebody-else');

    expect(response.status).toBe(404);
  });
});
