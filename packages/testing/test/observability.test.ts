import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOUDWATCH_METRICS, MAX_DIMENSIONS, emf, metricNamespace } from '@relayd/logger';

/**
 * Observability (BUILD-PLAN Phase 10; docs/10 "Observability" and "Alerts
 * that page").
 *
 * The property worth testing here is not that a metric can be emitted — it
 * is that the metric an alarm watches is one something actually writes.
 *
 * An alarm on a metric nobody emits does not fail. It sits in
 * INSUFFICIENT_DATA, which on a dashboard is a grey square among green ones
 * and reads as "quiet" rather than "broken". Every alarm in docs/10 is there
 * because the thing it watches is unrecoverable if missed — three of the
 * twelve are billing correctness — so an alarm that cannot fire is worse
 * than no alarm, because it is also a reason not to look.
 *
 * Nothing in Terraform or TypeScript can check a string against the other
 * language. This test is the mechanism.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const observabilityTf = path.resolve(
  here,
  '../../../infra/terraform/modules/observability/main.tf',
);

/** Every `metric_name` in our own namespace, as the alarms spell it. */
async function alarmedMetricNames(): Promise<string[]> {
  const source = await readFile(observabilityTf, 'utf8');
  const names = new Set<string>();

  // Paired with the namespace immediately above it, so the AWS/ApplicationELB
  // and AWS/RDS alarms — which watch metrics AWS emits, not us — are not
  // mistaken for ours.
  const pattern = /namespace\s*=\s*(\S+)\s*\n\s*metric_name\s*=\s*"([^"]+)"/gu;

  for (const match of source.matchAll(pattern)) {
    if (match[1]?.includes('local.namespace') === true && match[2] !== undefined) {
      names.add(match[2]);
    }
  }

  return [...names].sort();
}

describe('the alarms and the code agree on metric names', () => {
  it('finds alarms to check', async () => {
    // The tripwire. If the parse stopped matching — a formatting change, a
    // renamed local — the comparison below would compare two empty sets and
    // pass while every alarm watched nothing.
    const names = await alarmedMetricNames();

    expect(names.length).toBeGreaterThanOrEqual(10);
  });

  it('emits every metric an alarm watches', async () => {
    const alarmed = await alarmedMetricNames();
    const emitted = Object.values(CLOUDWATCH_METRICS);

    const watchedButNeverEmitted = alarmed.filter((name) => !emitted.includes(name as never));

    expect(watchedButNeverEmitted, 'alarms on metrics nothing writes').toEqual([]);
  });

  it('alarms on every metric it emits', async () => {
    // The other direction, and not a formality. A metric emitted with no
    // alarm is a number somebody is paying CloudWatch to store and nobody is
    // reading — either the alarm was dropped or the metric should have been.
    const alarmed = await alarmedMetricNames();
    const emitted = Object.values(CLOUDWATCH_METRICS);

    const emittedButNeverWatched = emitted.filter((name) => !alarmed.includes(name));

    expect(emittedButNeverWatched, 'metrics with no alarm').toEqual([]);
  });

  it('uses the namespace the alarms use', async () => {
    const source = await readFile(observabilityTf, 'utf8');

    // `local.namespace = "Relayd/${var.environment}"`, which is what
    // metricNamespace builds.
    expect(source).toContain('namespace = "Relayd/${var.environment}"');
    expect(metricNamespace('production')).toBe('Relayd/production');
  });
});

describe('EMF is shaped the way CloudWatch extracts', () => {
  it('nests the directive under _aws and the values at the top level', () => {
    const line = emf({
      namespace: metricNamespace('production'),
      metrics: [{ name: CLOUDWATCH_METRICS.queueDepth, value: 12 }],
      dimensions: { queue: 'email-send' },
    }) as Record<string, unknown> & { _aws: { CloudWatchMetrics: unknown[] } };

    // The value is a sibling of the directive, not inside it. This is the
    // part of EMF that is easy to get wrong and produces no error when you
    // do: CloudWatch accepts the line as a log entry and extracts nothing.
    expect(line['QueueDepth']).toBe(12);
    expect(line['queue']).toBe('email-send');
    expect(line._aws.CloudWatchMetrics).toHaveLength(1);
  });

  it('names the dimensions in the directive, not only in the body', () => {
    const line = emf({
      namespace: metricNamespace('staging'),
      metrics: [{ name: CLOUDWATCH_METRICS.sendFailures, value: 3 }],
      dimensions: { provider: 'ses' },
    }) as { _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] } };

    // A dimension present in the body but absent from `Dimensions` is
    // dropped from the metric and survives only as a log field — so the
    // alarm's `dimensions` block matches nothing and it never fires.
    expect(line._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([['provider']]);
  });

  it('defaults the unit to Count', () => {
    const line = emf({
      namespace: metricNamespace('staging'),
      metrics: [{ name: CLOUDWATCH_METRICS.deadLetters, value: 1 }],
    }) as { _aws: { CloudWatchMetrics: { Metrics: { Unit: string }[] }[] } };

    expect(line._aws.CloudWatchMetrics[0]?.Metrics[0]?.Unit).toBe('Count');
  });

  it('carries properties without turning them into metrics', () => {
    const line = emf({
      namespace: metricNamespace('production'),
      metrics: [{ name: CLOUDWATCH_METRICS.providerEventsUnmatched, value: 4 }],
      dimensions: { provider: 'sendgrid' },
      properties: { workspaceId: 'ws-1', requestId: 'req-1' },
    }) as Record<string, unknown> & {
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };

    // Searchable in Logs Insights, free, and — crucially — not a dimension.
    // A workspace id as a dimension is a billed CloudWatch metric per
    // workspace, forever.
    expect(line['workspaceId']).toBe('ws-1');
    expect(line._aws.CloudWatchMetrics[0]?.Dimensions[0]).not.toContain('workspaceId');
  });

  it('refuses an emit with no metrics', () => {
    // CloudWatch ignores such a line silently. Refusing it here is the only
    // place the mistake is visible.
    expect(() =>
      emf({ namespace: metricNamespace('staging'), metrics: [] }),
    ).toThrow(/no metrics/u);
  });

  it('refuses more dimensions than CloudWatch accepts', () => {
    const dimensions = Object.fromEntries(
      Array.from({ length: MAX_DIMENSIONS + 1 }, (_, index) => [`d${index}`, 'x']),
    );

    expect(() =>
      emf({
        namespace: metricNamespace('staging'),
        metrics: [{ name: CLOUDWATCH_METRICS.queueDepth, value: 1 }],
        dimensions,
      }),
    ).toThrow(/dimensions/u);
  });

  it('accepts exactly the maximum', () => {
    // The boundary from the allowed side. Without this the check above
    // passes just as well with an off-by-one that rejects a legal emit.
    const dimensions = Object.fromEntries(
      Array.from({ length: MAX_DIMENSIONS }, (_, index) => [`d${index}`, 'x']),
    );

    expect(() =>
      emf({
        namespace: metricNamespace('staging'),
        metrics: [{ name: CLOUDWATCH_METRICS.queueDepth, value: 1 }],
        dimensions,
      }),
    ).not.toThrow();
  });
});
