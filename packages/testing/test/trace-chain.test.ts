import { describe, expect, it } from 'vitest';
import {
  createLogger,
  getTraceContext,
  newRequestId,
  newTraceId,
  runWithTrace,
  updateTraceContext,
} from '@relayd/logger';
import { TRACE_FIELD, resumeTrace, withTrace, withoutTrace } from '@relayd/queue';

/**
 * The trace chain, end to end (BUILD-PLAN Phase 10; docs/10
 * "Observability").
 *
 * The acceptance test docs/10 writes down, verbatim: "given a customer
 * complaint 'my email to aisha@example.com never arrived', one query on
 * `campaign_recipient_id` returns the send attempt, the sender used, the
 * provider message id, every provider webhook received, and the log lines
 * from three services — in under a minute."
 *
 * The Phase 10 gate phrases the same thing as "a single email traceable from
 * request id → recipient id → provider message id in one query".
 *
 * ## What this proves and what it does not
 *
 * It follows one send through the three hops the ids have to survive:
 * the API request that launches a campaign, the queue boundary, and the
 * worker that calls the provider. At each hop it asserts the ids accumulate
 * rather than reset, and that the log lines carry them.
 *
 * What it cannot prove without infrastructure is the "in one query" half —
 * that a CloudWatch Logs Insights query over three log groups actually
 * returns these lines. That needs deployed log groups and is on the Phase 10
 * gate.
 *
 * The hop that breaks in practice is the queue. `AsyncLocalStorage` reaches
 * exactly as far as the process, and the send — the part anybody is asking
 * about — happens on the far side of it.
 */

/** Captures what the logger actually wrote, rather than what it was handed. */
function capturingLogger() {
  const lines: Record<string, unknown>[] = [];

  const logger = createLogger({
    name: 'trace-test',
    level: 'info',
    destination: {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  });

  return { logger, lines };
}

const ids = () => ({ requestId: newRequestId(), traceId: newTraceId() });

describe('the ids survive each hop', () => {
  it('starts with a request id and a trace id', () => {
    const context = { requestId: 'req-1', traceId: 'trace-1' };

    runWithTrace(context, () => {
      expect(getTraceContext()?.requestId).toBe('req-1');
      expect(getTraceContext()?.traceId).toBe('trace-1');
    });
  });

  it('accumulates ids as the request learns them', () => {
    // The API knows the workspace after auth, the campaign after validation,
    // the recipient only once the snapshot exists. Each one is added, none
    // replaces what came before.
    runWithTrace({ requestId: 'req-1', traceId: 'trace-1' }, () => {
      updateTraceContext({ workspaceId: 'ws-1' });
      updateTraceContext({ campaignId: 'camp-1' });
      updateTraceContext({ campaignRecipientId: 'rec-1' });

      const context = getTraceContext();
      expect(context).toMatchObject({
        requestId: 'req-1',
        traceId: 'trace-1',
        workspaceId: 'ws-1',
        campaignId: 'camp-1',
        campaignRecipientId: 'rec-1',
      });
    });
  });

  it('carries the context across the queue boundary', () => {
    // The hop AsyncLocalStorage cannot make. Without `_trace` in the
    // payload, the worker starts from nothing.
    const payload = runWithTrace(
      { requestId: 'req-1', traceId: 'trace-1', workspaceId: 'ws-1', campaignId: 'camp-1' },
      () => withTrace({ recipientId: 'rec-1' }),
    );

    expect(payload[TRACE_FIELD]).toMatchObject({
      requestId: 'req-1',
      traceId: 'trace-1',
      workspaceId: 'ws-1',
      campaignId: 'camp-1',
    });
  });

  it('resumes the producer trace in the consumer', async () => {
    const payload = runWithTrace({ requestId: 'req-1', traceId: 'trace-1' }, () =>
      withTrace({ recipientId: 'rec-1' }),
    );

    const seen = await resumeTrace(payload, 'job-9', async () => getTraceContext(), ids);

    expect(seen?.traceId).toBe('trace-1');
    expect(seen?.requestId).toBe('req-1');
  });

  it('gives the consumer the job id actually processing it', async () => {
    // Not the producer's, if the producer was itself a job. Two jobs sharing
    // an id in the logs is worse than the child having none.
    const payload = runWithTrace({ requestId: 'req-1', traceId: 'trace-1', jobId: 'parent' }, () =>
      withTrace({ recipientId: 'rec-1' }),
    );

    const seen = await resumeTrace(payload, 'child', async () => getTraceContext(), ids);

    expect(seen?.jobId).toBe('child');
    expect(seen?.traceId).toBe('trace-1');
  });

  it('starts a fresh trace rather than running untraced', async () => {
    // A scheduler tick has no producer. A job with no ids at all is the one
    // that cannot be followed afterwards.
    const seen = await resumeTrace({ recipientId: 'rec-1' }, 'job-9', async () => getTraceContext(), ids);

    expect(seen?.traceId).toBeTruthy();
    expect(seen?.jobId).toBe('job-9');
  });

  it('hides _trace from the consumer reading its own payload', () => {
    // Every consumer validates with Zod. An unrecognised key under
    // `.strict()` would reject the job, and a job failing validation because
    // of the field added to make it traceable is a bad trade.
    const payload = runWithTrace({ requestId: 'req-1', traceId: 'trace-1' }, () =>
      withTrace({ recipientId: 'rec-1' }),
    );

    expect(withoutTrace(payload)).toEqual({ recipientId: 'rec-1' });
    expect(TRACE_FIELD in withoutTrace(payload)).toBe(false);
  });

  it('leaves a payload alone when nothing is being traced', () => {
    // So a consumer can tell "no trace was running" from "a trace was
    // running and carried nothing".
    expect(withTrace({ recipientId: 'rec-1' })).toEqual({ recipientId: 'rec-1' });
  });
});

describe('request id to recipient id to provider message id, in the log lines', () => {
  it('links every hop by one trace id', async () => {
    // The gate, as a chain: a log line from the API, a log line from the
    // worker, and a log line from the provider adapter, joined by traceId,
    // with the recipient and the provider message id reachable from it.
    const { logger, lines } = capturingLogger();

    const requestId = newRequestId();
    const traceId = newTraceId();

    // --- hop 1: the API request that launches the campaign ---
    const job = runWithTrace({ requestId, traceId, workspaceId: 'ws-1' }, () => {
      updateTraceContext({ campaignId: 'camp-1' });
      logger.info({ event: 'campaign.launched' }, 'launched');

      return withTrace({ recipientId: 'rec-1' });
    });

    // --- hop 2 and 3: the worker, and the provider call inside it ---
    await resumeTrace(
      job,
      'job-42',
      async () => {
        updateTraceContext({ campaignRecipientId: 'rec-1' });
        logger.info({ event: 'send.started' }, 'sending');

        updateTraceContext({ providerId: 'conn-1', providerMessageId: 'ses-abc-123' });
        logger.info({ event: 'send.accepted' }, 'accepted');
      },
      ids,
    );

    expect(lines).toHaveLength(3);

    // One trace id across all three.
    expect(new Set(lines.map((line) => line['traceId']))).toEqual(new Set([traceId]));

    // And the request id survives to the far side of the queue, which is the
    // id a support ticket actually starts from.
    expect(new Set(lines.map((line) => line['requestId']))).toEqual(new Set([requestId]));

    const accepted = lines.at(-1);
    expect(accepted).toMatchObject({
      campaignRecipientId: 'rec-1',
      providerMessageId: 'ses-abc-123',
      jobId: 'job-42',
      workspaceId: 'ws-1',
      campaignId: 'camp-1',
    });
  });

  it('never puts a recipient address in the chain', () => {
    // docs/10: "`workspaceId` as a tag, never PII." The correlation set is
    // ids by construction, which is what makes it safe to write into a job
    // payload sitting in Redis and into a third-party error reporter.
    const payload = runWithTrace({ requestId: 'req-1', traceId: 'trace-1' }, () =>
      withTrace({ recipientId: 'rec-1' }),
    );

    expect(JSON.stringify(payload[TRACE_FIELD])).not.toMatch(/@/u);
  });
});
