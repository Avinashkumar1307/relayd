import { generateKeyPairSync } from 'node:crypto';
import express, { type Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@relayd/logger';
import type { GlobalMembershipRepository } from '@relayd/db';
import type { UserId, WorkspaceId, WorkspaceRole } from '@relayd/types';
import { PLANS } from '@relayd/billing';
import { requestContext } from '../src/middleware/authorize.js';
import { errorEnvelope } from '../src/middleware/error-envelope.js';
import { requestId } from '../src/middleware/request-id.js';
import { billingRoutes } from '../src/routes/billing.js';
import { TokenService } from '../src/services/tokens.js';
import type { BillingService } from '../src/services/billing.js';

/**
 * The billing routes over HTTP.
 *
 * One thing lives here and cannot be tested below: which permission each path
 * asks for. `billing:write` is owner-only — not admin — and CLAUDE.md §11 is
 * explicit that it can never be attached to an API key. Attaching
 * `billing:read` to a plan change instead would quietly hand every admin a
 * credit card, and nothing below the router would notice.
 */

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

function buildApp(role: WorkspaceRole, service: Partial<BillingService> = {}): Express {
  const findMembership = vi.fn(async (userId: UserId, workspaceId: WorkspaceId) =>
    userId === USER && workspaceId === WS
      ? { workspaceId: WS, workspaceName: 'ws', workspaceSlug: 'ws', role }
      : null,
  );

  const billing = {
    plans() {
      return [{ code: PLANS.growth, name: 'Growth' }];
    },
    async overview() {
      return { subscription: null, state: {}, usage: [], paymentMethod: null };
    },
    async usage() {
      return [];
    },
    async invoices() {
      return [];
    },
    async entitlementCheck() {
      return { allowed: true };
    },
    async startCheckout() {
      return { id: 'cs_1', url: 'https://checkout.stripe.com/cs_1', expiresAt: new Date() };
    },
    async checkoutStatus() {
      return { ready: false, action: 'poll' };
    },
    async portalSession() {
      return { url: 'https://billing.stripe.com/p/1' };
    },
    async planChangePreview() {
      return { from: PLANS.growth, to: PLANS.starter, blocked: false, conflicts: [] };
    },
    async changePlan() {
      return { direction: 'upgrade', appliesAt: 'immediately', effectiveAt: null };
    },
    async cancel() {
      return { endsAt: null };
    },
    async reactivate() {
      return { ok: true };
    },
    async retryPayment() {
      return { ok: true };
    },
    async updateDetails(_scope: unknown, input: unknown) {
      return input;
    },
    async requestExport() {
      return { ok: true };
    },
    ...service,
  } as unknown as BillingService;

  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(requestContext);
  app.use(
    '/api/v1',
    billingRoutes({
      billing,
      tokens,
      memberships: { findMembership } as unknown as GlobalMembershipRepository,
    }),
  );
  app.use(
    errorEnvelope(
      createLogger({ name: 'test', level: 'fatal', destination: { write: () => undefined } }),
    ),
  );

  return app;
}

let bearer: string;

beforeAll(async () => {
  bearer = await tokens.issueAccessToken({ sub: USER, sid: 'session-1', wsIds: [WS], ver: 1 });
});

function auth(app: Express, method: 'get' | 'post' | 'patch', path: string) {
  return request(app)[method](path)
    .set('Authorization', `Bearer ${bearer}`)
    .set('X-Workspace-Id', WS);
}

describe('billing:write is owner-only (CLAUDE.md section 11)', () => {
  it('lets an owner start checkout', async () => {
    const res = await auth(buildApp('owner'), 'post', '/api/v1/billing/checkout').send({
      planCode: PLANS.growth,
      interval: 'month',
    });

    expect(res.status).toBe(201);
  });

  it('refuses an admin', async () => {
    // Not a typo and not an oversight: money is the owner's alone. An admin
    // who could change the plan could also cancel it.
    const res = await auth(buildApp('admin'), 'post', '/api/v1/billing/checkout').send({
      planCode: PLANS.growth,
      interval: 'month',
    });

    expect(res.status).toBe(403);
  });

  it('refuses an admin a plan change', async () => {
    const res = await auth(buildApp('admin'), 'post', '/api/v1/billing/plan').send({
      planCode: PLANS.business,
      interval: 'month',
    });

    expect(res.status).toBe(403);
  });

  it('refuses an admin a cancellation', async () => {
    const res = await auth(buildApp('admin'), 'post', '/api/v1/billing/cancel').send({});

    expect(res.status).toBe(403);
  });

  it('refuses an admin the portal', async () => {
    // The Stripe portal changes the card and can cancel the subscription.
    const res = await auth(buildApp('admin'), 'post', '/api/v1/billing/portal').send({});

    expect(res.status).toBe(403);
  });

  it('refuses an editor everything that writes', async () => {
    for (const path of ['/api/v1/billing/checkout', '/api/v1/billing/plan', '/api/v1/billing/cancel']) {
      const res = await auth(buildApp('editor'), 'post', path).send({
        planCode: PLANS.growth,
        interval: 'month',
      });

      expect(res.status, path).toBe(403);
    }
  });
});

describe('billing:read', () => {
  it('lets an admin see the page', async () => {
    // Reading is `billing:read`, which admins hold. An admin who cannot see
    // the plan cannot answer "why did the send stop".
    expect((await auth(buildApp('admin'), 'get', '/api/v1/billing')).status).toBe(200);
  });

  it('refuses an editor', async () => {
    expect((await auth(buildApp('editor'), 'get', '/api/v1/billing')).status).toBe(403);
  });

  it('refuses a viewer', async () => {
    expect((await auth(buildApp('viewer'), 'get', '/api/v1/billing')).status).toBe(403);
  });

  it('covers usage, invoices and the preview', async () => {
    const app = buildApp('admin');

    for (const path of [
      '/api/v1/billing/usage',
      '/api/v1/billing/invoices',
      '/api/v1/billing/plan-change/preview?planCode=starter',
      '/api/v1/billing/checkout/status?elapsedMs=0',
    ]) {
      expect((await auth(app, 'get', path)).status, path).toBe(200);
    }
  });

  it('lets a non-owner poll the success page', async () => {
    // The person who paid may not be the owner, and leaving them on a spinner
    // because they cannot poll is worse than the failure the endpoint exists
    // to prevent.
    const res = await auth(buildApp('admin'), 'get', '/api/v1/billing/checkout/status?elapsedMs=0');

    expect(res.status).toBe(200);
  });
});

describe('the pricing page', () => {
  it('needs no authentication', async () => {
    // A signed-out visitor has to be able to see what things cost.
    const res = await request(buildApp('owner')).get('/api/v1/billing/plans');

    expect(res.status).toBe(200);
    expect(res.body.data[0].code).toBe(PLANS.growth);
  });
});

describe('validation', () => {
  it('refuses a checkout with no plan', async () => {
    const res = await auth(buildApp('owner'), 'post', '/api/v1/billing/checkout').send({
      interval: 'month',
      email: 'a@example.com',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('refuses an interval that is not a month or a year', async () => {
    const res = await auth(buildApp('owner'), 'post', '/api/v1/billing/checkout').send({
      planCode: PLANS.growth,
      interval: 'week',
      email: 'a@example.com',
    });

    expect(res.status).toBe(400);
  });

  it('names the offending field', async () => {
    const res = await auth(buildApp('owner'), 'post', '/api/v1/billing/checkout').send({
      planCode: PLANS.growth,
      interval: 'week',
    });

    expect(res.body.error.details?.[0]?.path).toBe('interval');
  });

  it('ignores an email the client supplies', async () => {
    // The billing address is the owner's and is read server-side. A client
    // that could choose it could point a Stripe customer's receipts at
    // somebody else.
    let seen: Record<string, unknown> = {};
    const app = buildApp('owner', {
      async startCheckout(_scope: never, input: Record<string, unknown>) {
        seen = input;
        return { id: 'cs', url: 'https://x', expiresAt: new Date() };
      },
    } as never);

    await auth(app, 'post', '/api/v1/billing/checkout').send({
      planCode: PLANS.growth,
      interval: 'month',
      email: 'attacker@example.com',
    });

    expect(seen['email']).toBeUndefined();
  });

  it('defaults a cancellation to period end', async () => {
    // Immediate cancellation ends a paid period with no refund, so it is a
    // thing the caller says rather than gets by leaving a field out.
    let seen: { immediately?: boolean } = {};
    const app = buildApp('owner', {
      async cancel(_scope: never, input: { immediately: boolean }) {
        seen = input;
        return { endsAt: null };
      },
    } as never);

    await auth(app, 'post', '/api/v1/billing/cancel').send({});

    expect(seen.immediately).toBe(false);
  });

  it('refuses a preview with no plan code', async () => {
    const res = await auth(buildApp('admin'), 'get', '/api/v1/billing/plan-change/preview');

    expect(res.status).toBe(400);
  });
});

describe('the read-only entitlement check', () => {
  it('reports rather than refuses', async () => {
    // 200 with the decision in the body. This endpoint exists to show a
    // customer where they stand; the real gate runs inside the transaction of
    // the action it gates.
    const app = buildApp('admin', {
      async entitlementCheck() {
        return {
          allowed: false,
          code: 'limit_reached',
          message: 'over',
          shortfall: 500,
        };
      },
    } as never);

    const res = await auth(app, 'get', '/api/v1/billing/entitlements/check?feature=emails.sent&requested=10');

    expect(res.status).toBe(200);
    expect(res.body.data.allowed).toBe(false);
    expect(res.body.data.advisoryStatus).toBe(402);
  });

  it('refuses a request with no feature', async () => {
    const res = await auth(buildApp('admin'), 'get', '/api/v1/billing/entitlements/check');

    expect(res.status).toBe(400);
  });
});

describe('a workspace the caller does not belong to', () => {
  it('is a 404, never a 403', async () => {
    // Layer one. A 403 confirms the workspace exists.
    const res = await request(buildApp('owner'))
      .get('/api/v1/billing')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-Workspace-Id', 'ws-someone-else');

    expect(res.status).toBe(404);
  });
});

/**
 * The four I-frame actions added in the delivery-and-money batch.
 *
 * Every one of them is `billing:write`, which is owner-only and can never be
 * attached to an API key. Reactivating a subscription and retrying a payment
 * are both money; a billing address and a VAT id are what a company's
 * invoices are issued against.
 */
describe('reactivate, retry, details and export are owner-only', () => {
  it.each([
    ['post', '/api/v1/billing/reactivate'],
    ['post', '/api/v1/billing/retry-payment'],
    ['post', '/api/v1/billing/export'],
  ] as const)('refuses an admin %s %s', async (method, path) => {
    const res = await auth(buildApp('admin'), method, path).send({});
    expect(res.status).toBe(403);
  });

  it('refuses an admin the details form', async () => {
    const res = await auth(buildApp('admin'), 'patch', '/api/v1/billing/details').send({
      email: 'finance@northwind.travel',
      company: 'Northwind',
      address: 'Dubai',
      taxId: 'AE1',
    });

    expect(res.status).toBe(403);
  });

  it('lets an owner reactivate and retry', async () => {
    expect((await auth(buildApp('owner'), 'post', '/api/v1/billing/reactivate').send({})).status).toBe(200);
    expect((await auth(buildApp('owner'), 'post', '/api/v1/billing/retry-payment').send({})).status).toBe(200);
  });

  it('answers 202 to an export, because the data is not in the response', async () => {
    const res = await auth(buildApp('owner'), 'post', '/api/v1/billing/export').send({});
    expect(res.status).toBe(202);
  });

  it('validates the details form and refuses an unknown field', async () => {
    // `.strict()`. A client sending `country` is told the field does not
    // exist rather than having it silently dropped and wondering why their
    // invoices are still wrong.
    const bad = await auth(buildApp('owner'), 'patch', '/api/v1/billing/details').send({
      email: 'not-an-address',
    });
    expect(bad.status).toBe(400);

    const extra = await auth(buildApp('owner'), 'patch', '/api/v1/billing/details').send({
      email: 'finance@northwind.travel',
      country: 'AE',
    });
    expect(extra.status).toBe(400);
  });

  it('defaults the optional fields so a half-filled form saves', async () => {
    const res = await auth(buildApp('owner'), 'patch', '/api/v1/billing/details').send({
      email: 'finance@northwind.travel',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      email: 'finance@northwind.travel',
      company: '',
      address: '',
      taxId: '',
    });
  });
});
