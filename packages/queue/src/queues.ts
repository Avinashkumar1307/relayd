/**
 * The queue catalogue.
 *
 * Every queue declares `concurrency`, `lockDuration`, `attempts`, `backoff`,
 * `removeOnComplete` and `removeOnFail` explicitly. CLAUDE.md §9: "Defaults
 * are never accepted." A BullMQ default that suits one queue is wrong for
 * another, and the ones that bite — an unbounded completed set filling Redis,
 * a stalled job re-run while the first is still sending — are invisible until
 * they are expensive.
 *
 * Settings follow docs/04 §12's catalogue with the amendments in H applied.
 * Where the two disagree, H wins; each such case is noted at the queue.
 *
 * No queue carries a `repeat` option. Recurring work comes from
 * `scheduled_jobs` in Postgres (INVARIANTS R23), because a BullMQ repeatable
 * lives in Redis and a flush loses every recurring job without an error.
 */

export const QUEUE_NAMES = [
  'campaign-launch',
  'campaign-dispatch',
  'email-send',
  'recipient-sweeper',
  'campaign-reconcile',
  'event-ingest',
  'analytics-rollup',
  'billing-webhook',
  'billing-refetch',
  'billing-reconcile',
  'billing-processing',
  'contact-import',
  'provider-verify',
  'outbound-webhook',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface BackoffSettings {
  type: 'fixed' | 'exponential';
  delay: number;
  /** BullMQ has no cap of its own; the worker applies this. */
  maxDelay?: number;
}

export interface QueueSettings {
  readonly name: QueueName;
  /** Jobs processed at once, per worker process. */
  readonly concurrency: number;
  /**
   * How long a job may hold its lock before BullMQ considers it stalled.
   *
   * Must exceed the longest a single job can legitimately take, or a working
   * job is handed to a second worker while the first is still running.
   */
  readonly lockDuration: number;
  readonly attempts: number;
  readonly backoff: BackoffSettings;
  /** Completed jobs kept, by count and by age in seconds. */
  readonly removeOnComplete: { count: number; age: number };
  /**
   * Failed jobs kept. `false` means never remove — only billing-webhook,
   * where a dropped event is money or entitlement drift.
   */
  readonly removeOnFail: { count: number; age: number } | false;
  /**
   * How many times a job may be recovered after stalling.
   *
   * Zero means a stalled job fails immediately rather than being re-run. Only
   * email-send sets it, and it is the most important number in this file.
   */
  readonly maxStalledCount?: number;
  /** Paged: an operator should be woken when this queue dead-letters. */
  readonly critical?: boolean;
  readonly description: string;
}

const HOUR = 3600;
const DAY = 24 * HOUR;

export const QUEUE_SETTINGS: Readonly<Record<QueueName, QueueSettings>> = {
  'campaign-launch': {
    name: 'campaign-launch',
    concurrency: 2,
    // A launch snapshots the audience, which for a large list is minutes.
    lockDuration: 30 * 60_000,
    attempts: 3,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { count: 1000, age: DAY },
    removeOnFail: { count: 5000, age: 30 * DAY },
    critical: true,
    description: 'Validates and snapshots a campaign audience.',
  },

  'campaign-dispatch': {
    name: 'campaign-dispatch',
    // One per campaign, long-running and self-refilling. Three dispatchers
    // for one campaign gain nothing — the claim query already serialises —
    // and triple the chance of a throttle miscalculation (docs/04).
    concurrency: 1,
    lockDuration: 6 * HOUR * 1000,
    attempts: 3,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { count: 100, age: HOUR },
    removeOnFail: { count: 1000, age: 7 * DAY },
    critical: true,
    description: 'Claims recipients in batches and enqueues sends.',
  },

  'email-send': {
    name: 'email-send',
    // 25, not 200. Per-sender concurrency is the rate limiter's job; a high
    // worker concurrency just means more workers blocked on tokens.
    concurrency: 25,
    // 120s, per amendment H. The provider timeout is capped below it (30s
    // API, 60s SMTP) so a slow provider can never outlive the lock.
    lockDuration: 120_000,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000, maxDelay: 5 * 60_000 },
    removeOnComplete: { count: 10_000, age: HOUR },
    removeOnFail: { count: 50_000, age: 7 * DAY },
    /**
     * Zero. The most important setting here.
     *
     * A stalled send that BullMQ recovers is a send that may already have
     * reached the provider — recovering it sends the same email twice. The
     * durable guard is the state transition in Postgres, and the reconciler
     * resolves anything ambiguous (D3). Never let BullMQ decide.
     */
    maxStalledCount: 0,
    critical: true,
    description: 'Sends one recipient through the provider adapter.',
  },

  'recipient-sweeper': {
    name: 'recipient-sweeper',
    concurrency: 1,
    lockDuration: 5 * 60_000,
    attempts: 3,
    backoff: { type: 'fixed', delay: 30_000 },
    removeOnComplete: { count: 100, age: HOUR },
    removeOnFail: { count: 1000, age: 7 * DAY },
    description:
      'Every 60s: queued older than 5 min back to pending; sending older than 10 min to delivery_uncertain.',
  },

  'campaign-reconcile': {
    name: 'campaign-reconcile',
    concurrency: 1,
    lockDuration: 10 * 60_000,
    attempts: 3,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { count: 100, age: HOUR },
    removeOnFail: { count: 1000, age: 7 * DAY },
    description: 'Force-exits stale transient campaign states; recomputes counters hourly.',
  },

  'event-ingest': {
    name: 'event-ingest',
    concurrency: 20,
    lockDuration: 30_000,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000, maxDelay: 5 * 60_000 },
    removeOnComplete: { count: 10_000, age: 6 * HOUR },
    removeOnFail: { count: 50_000, age: 30 * DAY },
    description: 'Interprets a stored provider webhook event against its connection.',
  },

  'analytics-rollup': {
    name: 'analytics-rollup',
    concurrency: 8,
    lockDuration: 5 * 60_000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000, maxDelay: 5 * 60_000 },
    removeOnComplete: { count: 1000, age: HOUR },
    removeOnFail: { count: 5000, age: 7 * DAY },
    description: 'Recomputes a bounded window from email_events (F24: never watermark-incremental).',
  },

  'billing-webhook': {
    name: 'billing-webhook',
    concurrency: 5,
    lockDuration: 60_000,
    attempts: 8,
    backoff: { type: 'exponential', delay: 5000, maxDelay: HOUR * 1000 },
    removeOnComplete: { count: 10_000, age: 30 * DAY },
    /**
     * Never removed.
     *
     * A dropped billing event is money or entitlement drift. Failed jobs stay
     * forever, page an operator, and are replayable by hand (docs/04).
     */
    removeOnFail: false,
    critical: true,
    description: 'Records a verified Stripe event and marks the object dirty.',
  },

  'billing-refetch': {
    name: 'billing-refetch',
    concurrency: 2,
    lockDuration: 60_000,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000, maxDelay: 10 * 60_000 },
    removeOnComplete: { count: 1000, age: DAY },
    removeOnFail: { count: 5000, age: 30 * DAY },
    critical: true,
    description: 'Coalesced re-fetch of a dirty Stripe object, at most once per 30s.',
  },

  'billing-reconcile': {
    name: 'billing-reconcile',
    concurrency: 1,
    lockDuration: 30 * 60_000,
    attempts: 3,
    backoff: { type: 'fixed', delay: 5 * 60_000 },
    removeOnComplete: { count: 100, age: 7 * DAY },
    removeOnFail: { count: 1000, age: 90 * DAY },
    critical: true,
    description: 'Nightly comparison of local billing state with Stripe.',
  },

  'billing-processing': {
    name: 'billing-processing',
    concurrency: 5,
    lockDuration: 5 * 60_000,
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000, maxDelay: 10 * 60_000 },
    removeOnComplete: { count: 1000, age: 7 * DAY },
    removeOnFail: { count: 5000, age: 90 * DAY },
    critical: true,
    description: 'Entitlement rebuilds, metering rollups and dunning transitions.',
  },

  'contact-import': {
    name: 'contact-import',
    concurrency: 2,
    // A 500,000-row import is minutes to an hour. The lock must outlast it or
    // a second worker starts the same file.
    lockDuration: 2 * HOUR * 1000,
    attempts: 2,
    backoff: { type: 'fixed', delay: 5 * 60_000 },
    removeOnComplete: { count: 1000, age: 7 * DAY },
    removeOnFail: { count: 5000, age: 30 * DAY },
    description: 'Parses an uploaded file and merges contacts.',
  },

  'provider-verify': {
    name: 'provider-verify',
    concurrency: 4,
    lockDuration: 2 * 60_000,
    attempts: 2,
    backoff: { type: 'fixed', delay: 60_000 },
    removeOnComplete: { count: 1000, age: DAY },
    removeOnFail: { count: 5000, age: 7 * DAY },
    description: 'Re-checks one workspace’s provider connections.',
  },

  'outbound-webhook': {
    name: 'outbound-webhook',
    concurrency: 20,
    lockDuration: 30_000,
    attempts: 6,
    backoff: { type: 'exponential', delay: 10_000, maxDelay: 6 * HOUR * 1000 },
    removeOnComplete: { count: 10_000, age: DAY },
    removeOnFail: { count: 50_000, age: 30 * DAY },
    description: 'Delivers a domain event to a customer endpoint.',
  },
};

/** Queues whose dead letters wake someone. */
export const CRITICAL_QUEUES: ReadonlySet<QueueName> = new Set(
  QUEUE_NAMES.filter((name) => QUEUE_SETTINGS[name].critical === true),
);

/**
 * The BullMQ job options for a queue.
 *
 * Built from the settings rather than written twice, so a queue cannot be
 * declared in the table and enqueued with something else.
 */
export function jobOptionsFor(name: QueueName): {
  attempts: number;
  backoff: { type: 'fixed' | 'exponential'; delay: number };
  removeOnComplete: { count: number; age: number };
  removeOnFail: { count: number; age: number } | false;
} {
  const settings = QUEUE_SETTINGS[name];

  return {
    attempts: settings.attempts,
    backoff: { type: settings.backoff.type, delay: settings.backoff.delay },
    removeOnComplete: settings.removeOnComplete,
    removeOnFail: settings.removeOnFail,
  };
}

/**
 * The BullMQ worker options for a queue.
 */
export function workerOptionsFor(name: QueueName): {
  concurrency: number;
  lockDuration: number;
  maxStalledCount?: number;
} {
  const settings = QUEUE_SETTINGS[name];

  return {
    concurrency: settings.concurrency,
    lockDuration: settings.lockDuration,
    ...(settings.maxStalledCount === undefined
      ? {}
      : { maxStalledCount: settings.maxStalledCount }),
  };
}

/**
 * The deterministic job id for a unit of work.
 *
 * Every queue has one, and it is what makes a dead-letter replay safe:
 * re-enqueueing with the original id is a no-op if the job already
 * succeeded. It is a dedupe *optimisation* for sends — the durable guard is
 * the Postgres state transition (CLAUDE.md §9) — and the durable guarantee
 * for replay.
 */
export const jobIds = {
  campaignLaunch: (campaignId: string) => `campaign:${campaignId}:launch`,
  campaignDispatch: (campaignId: string) => `campaign:${campaignId}:dispatch`,
  emailSend: (recipientId: string) => `send:${recipientId}`,
  eventIngest: (connectionId: string, eventId: string) => `pwh:${connectionId}:${eventId}`,
  billingWebhook: (provider: string, eventId: string) => `bwh:${provider}:${eventId}`,
  contactImport: (importId: string) => `import:${importId}`,
  analyticsRollup: (scope: string, refId: string, bucket: string) =>
    `rollup:${scope}:${refId}:${bucket}`,
  outboundWebhook: (endpointId: string, eventId: string) => `owh:${endpointId}:${eventId}`,
  providerVerify: (workspaceId: string, bucket: string) => `pv:${workspaceId}:${bucket}`,
  /** Sweepers and reconcilers are per tick, so the tick identifies them. */
  scheduled: (name: string, bucket: string) => `sched:${name}:${bucket}`,
} as const;
