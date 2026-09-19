import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type Metric,
} from 'prom-client';

/**
 * Metrics (docs/10 "Observability"; BUILD-PLAN Phase 10).
 *
 * ## Why a fixed catalogue rather than an ad-hoc API
 *
 * If metric names were created wherever somebody needed one, two series
 * would end up measuring the same thing under different names and a
 * dashboard would quietly show one of them. So the names live here, in one
 * list, exported as constants.
 *
 * ## This is not what the alarms watch
 *
 * Worth being exact about, because the two are easy to conflate. The twelve
 * alarms in docs/10 "Alerts that page" are CloudWatch alarms, and a
 * CloudWatch alarm watches a CloudWatch metric. Those are emitted as EMF log
 * lines from `emf.ts`, and their names are `CLOUDWATCH_METRICS` there.
 *
 * What is here is the Prometheus exposition served at `/metrics`, which
 * nothing scrapes yet — docs/10: "Prometheus + Grafana only once someone
 * owns it." It is for a local `curl` during an incident and for whoever
 * eventually owns that stack.
 *
 * ## Labels and cardinality
 *
 * `workspaceId` is deliberately **not** a label. It is in every log line,
 * where cardinality costs storage, and it would be in every metric series,
 * where cardinality costs memory in this process and money in CloudWatch.
 * A per-workspace number is a query against `email_events`, not a metric.
 *
 * The exception is the complaint rate, which docs/10 pages on per workspace.
 * It is emitted as an EMF log line rather than held as a series, for the
 * same reason.
 */

/** The one registry. Exported so `/metrics` can render it. */
export const registry = new Registry();

/**
 * Metric names, as the alarms in `infra/terraform/modules/observability`
 * spell them. Changing one here without changing it there disables an alarm.
 */
export const METRICS = {
  httpRequestDuration: 'relayd_http_request_duration_seconds',
  httpRequestsTotal: 'relayd_http_requests_total',

  queueDepth: 'relayd_queue_depth',
  queueDeadLetters: 'relayd_queue_dead_letters_total',
  jobDuration: 'relayd_job_duration_seconds',
  jobsTotal: 'relayd_jobs_total',

  emailSendsTotal: 'relayd_email_sends_total',
  providerCallDuration: 'relayd_provider_call_duration_seconds',

  billingWebhooksTotal: 'relayd_billing_webhooks_total',
  billingDivergence: 'relayd_billing_divergence',
  usageReconciliationMismatch: 'relayd_usage_reconciliation_mismatch',

  webhookUnmatchedTotal: 'relayd_webhook_unmatched_total',
  secretFetchTotal: 'relayd_secret_fetch_total',
} as const;

export type MetricName = (typeof METRICS)[keyof typeof METRICS];

/**
 * Buckets for HTTP and job latency, in seconds.
 *
 * Chosen around the thresholds that are alarmed on rather than around a
 * default: docs/10 pages on API p99 above 2 s, so there are bucket
 * boundaries either side of it. A histogram whose nearest boundary is 1 s
 * and then 5 s cannot answer "is p99 above 2 s" at all — it can only say
 * "somewhere between 1 and 5", which is exactly the question being asked.
 */
const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10, 30];

/**
 * Buckets for a provider call, which is a network round trip to somebody
 * else's API and has a completely different shape: the interesting region is
 * whole seconds, and the timeout (30 s API, 60 s SMTP — CLAUDE.md section 9)
 * is where the tail matters.
 */
const PROVIDER_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 45, 60, 120];

export const httpRequestDuration = new Histogram({
  name: METRICS.httpRequestDuration,
  help: 'HTTP request duration in seconds',
  // `route` is the Express route pattern, never `req.path`. The path carries
  // ids, and a series per campaign id would be unbounded.
  labelNames: ['method', 'route', 'status', 'process'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: METRICS.httpRequestsTotal,
  help: 'HTTP requests by outcome',
  labelNames: ['method', 'route', 'status', 'process'],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: METRICS.queueDepth,
  help: 'Jobs waiting in a queue',
  labelNames: ['queue', 'state'],
  registers: [registry],
});

export const queueDeadLetters = new Counter({
  name: METRICS.queueDeadLetters,
  help: 'Jobs moved to a dead-letter queue',
  labelNames: ['queue'],
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: METRICS.jobDuration,
  help: 'Job processing duration in seconds',
  labelNames: ['queue', 'outcome'],
  buckets: LATENCY_BUCKETS,
  registers: [registry],
});

export const jobsTotal = new Counter({
  name: METRICS.jobsTotal,
  help: 'Jobs processed by outcome',
  labelNames: ['queue', 'outcome'],
  registers: [registry],
});

/**
 * Sends, by outcome.
 *
 * `outcome` carries `delivery_uncertain` as its own value rather than
 * folding it into `failed`. D3: a crash after the provider accepted leaves a
 * recipient that was probably delivered and is definitely unbilled, and the
 * whole point of the state is that it is neither a success nor a failure.
 * Counting it as either would hide the number that says whether D3's default
 * is costing anything.
 */
export const emailSendsTotal = new Counter({
  name: METRICS.emailSendsTotal,
  help: 'Send attempts by provider and outcome',
  labelNames: ['provider', 'outcome'],
  registers: [registry],
});

export const providerCallDuration = new Histogram({
  name: METRICS.providerCallDuration,
  help: 'Provider API call duration in seconds',
  labelNames: ['provider', 'operation', 'outcome'],
  buckets: PROVIDER_BUCKETS,
  registers: [registry],
});

export const billingWebhooksTotal = new Counter({
  name: METRICS.billingWebhooksTotal,
  help: 'Stripe webhook events by outcome',
  labelNames: ['type', 'outcome'],
  registers: [registry],
});

/**
 * R19. The nightly reconciler sets this to the number of workspaces whose
 * local billing state disagrees with Stripe.
 *
 * A gauge rather than a counter because the question is "how many are wrong
 * right now", and because it must be able to go back to zero — a counter
 * that only ever rises cannot express "we fixed it".
 */
export const billingDivergence = new Gauge({
  name: METRICS.billingDivergence,
  help: 'Workspaces whose billing state diverges from Stripe',
  labelNames: ['kind'],
  registers: [registry],
});

export const usageReconciliationMismatch = new Gauge({
  name: METRICS.usageReconciliationMismatch,
  help: 'Workspaces whose metered usage disagrees with the ledger',
  registers: [registry],
});

export const webhookUnmatchedTotal = new Counter({
  name: METRICS.webhookUnmatchedTotal,
  help: 'Provider webhook events that matched no recipient',
  labelNames: ['provider'],
  registers: [registry],
});

export const secretFetchTotal = new Counter({
  name: METRICS.secretFetchTotal,
  help: 'Secrets Manager fetches by outcome',
  labelNames: ['outcome', 'cached'],
  registers: [registry],
});

/**
 * Registers the Node process metrics: event loop lag, GC pauses, heap, file
 * descriptors, resident memory.
 *
 * Called once per process, from the entrypoint. Not at module load, because
 * importing this file in a test would then start a collection interval that
 * keeps the process alive and makes vitest hang at the end of a run — a
 * failure that reads as a stuck test rather than as a metrics problem.
 */
export function collectProcessMetrics(process_: string): void {
  collectDefaultMetrics({
    register: registry,
    labels: { process: process_ },
  });
}

/** The exposition-format body for `/metrics`. */
export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}

/**
 * Every metric name currently registered.
 *
 * Exists for the test that compares this catalogue with the alarms in
 * Terraform. Reads the registry rather than the `METRICS` constant, so a
 * name that is declared but attached to no metric is visible as a gap.
 */
export function registeredMetricNames(): string[] {
  // `getMetricsAsArray` is typed loosely; the name is the only field wanted.
  const metrics = registry.getMetricsAsArray() as unknown as Metric[];
  return metrics.map((metric) => (metric as unknown as { name: string }).name).sort();
}

/**
 * Resets every metric. Tests only.
 *
 * Counters are process-lifetime values, and a test that asserted on one
 * would otherwise depend on which tests ran before it in the same worker.
 */
export function resetMetrics(): void {
  registry.resetMetrics();
}
