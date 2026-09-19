/**
 * CloudWatch Embedded Metric Format (docs/10 "Observability").
 *
 * ## Why this exists alongside `metrics.ts`
 *
 * They are not alternatives. `metrics.ts` holds Prometheus series in process
 * memory and renders them when something scrapes `/metrics`. The alarms that
 * page — all twelve of them, in
 * `infra/terraform/modules/observability` — are CloudWatch alarms, and a
 * CloudWatch alarm can only watch a CloudWatch metric.
 *
 * Nothing scrapes `/metrics` yet, on purpose: docs/10 says "Prometheus +
 * Grafana only once someone owns it." So if the alarms were left watching
 * Prometheus series, every one of them would sit in INSUFFICIENT_DATA
 * forever, which is indistinguishable at a glance from a system that never
 * misbehaves. That is the worst failure an alarm has.
 *
 * EMF closes it without an agent, an SDK or a push: a log line of a
 * particular shape, written to the log group the task already writes to, is
 * extracted by CloudWatch into a metric. It costs one JSON object.
 *
 * ## The names are the contract
 *
 * `CLOUDWATCH_METRICS` below and the `metric_name` arguments in the
 * Terraform must agree exactly, and nothing in either language can check
 * that. `packages/testing/test/observability.test.ts` reads both and fails
 * when they drift — the only mechanism available across that boundary, and
 * the reason the names are a frozen object rather than string literals at
 * the call sites.
 */

/**
 * Every custom metric an alarm in `infra/terraform/modules/observability`
 * watches. One entry per `metric_name` in that file whose namespace is ours.
 */
export const CLOUDWATCH_METRICS = {
  queueDepth: 'QueueDepth',
  deadLetters: 'DeadLetters',

  sendAttempts: 'SendAttempts',
  sendFailures: 'SendFailures',

  billingWebhookFailures: 'BillingWebhookFailures',
  billingDivergence: 'BillingDivergence',
  usageReconciliationDrift: 'UsageReconciliationDrift',

  providerEventsReceived: 'ProviderEventsReceived',
  providerEventsUnmatched: 'ProviderEventsUnmatched',

  workspaceComplaintRate: 'WorkspaceComplaintRate',
} as const;

export type CloudWatchMetric = (typeof CLOUDWATCH_METRICS)[keyof typeof CLOUDWATCH_METRICS];

/** CloudWatch's unit vocabulary, narrowed to what we emit. */
export type MetricUnit = 'Count' | 'Seconds' | 'Milliseconds' | 'Percent' | 'None';

export interface EmfMetric {
  name: CloudWatchMetric;
  value: number;
  unit?: MetricUnit;
}

export interface EmfOptions {
  /** `Relayd/{env}`, matching `local.namespace` in the Terraform. */
  namespace: string;
  metrics: EmfMetric[];
  /**
   * The dimensions an alarm groups by. Keep this short: CloudWatch bills per
   * unique dimension combination, and every distinct set is its own metric.
   */
  dimensions?: Record<string, string>;
  /** Extra fields, searchable in Logs Insights but not turned into metrics. */
  properties?: Record<string, unknown>;
  timestamp?: number;
}

/** CloudWatch rejects a dimension set larger than this. */
export const MAX_DIMENSIONS = 30;

/**
 * Builds one EMF log object. Write it with `logger.info(emf(...))` — it is a
 * log line, and its being a log line is the entire mechanism.
 *
 * `workspaceId` deserves a warning it does not get from the type: as a
 * *dimension* it creates a CloudWatch metric per workspace, billed monthly,
 * forever. `WorkspaceComplaintRate` is the one alarm docs/10 wants that way.
 * Everywhere else it belongs in `properties`, where it is searchable and
 * free.
 */
export function emf(options: EmfOptions): Record<string, unknown> {
  const dimensions = options.dimensions ?? {};
  const names = Object.keys(dimensions);

  if (names.length > MAX_DIMENSIONS) {
    throw new Error(`emf: ${names.length} dimensions; CloudWatch allows ${MAX_DIMENSIONS}`);
  }

  if (options.metrics.length === 0) {
    // An EMF object with no metrics is silently ignored by CloudWatch. It
    // would look like a successful emit at every point in our code and
    // produce no series at all, so it is refused here where the stack trace
    // still points at the caller.
    throw new Error('emf: no metrics to emit');
  }

  const values: Record<string, number> = {};
  for (const metric of options.metrics) values[metric.name] = metric.value;

  return {
    _aws: {
      Timestamp: options.timestamp ?? Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: options.namespace,
          // A single dimension set. EMF allows several, which multiplies the
          // metrics produced by one log line; one set keeps the cost of a
          // line obvious from reading it.
          Dimensions: [names],
          Metrics: options.metrics.map((metric) => ({
            Name: metric.name,
            Unit: metric.unit ?? 'Count',
          })),
        },
      ],
    },
    ...dimensions,
    ...values,
    ...(options.properties ?? {}),
  };
}

/** `Relayd/{env}`, as `local.namespace` in the Terraform spells it. */
export function metricNamespace(environment: string): string {
  return `Relayd/${environment}`;
}
