import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { newRequestId, newTraceId, runWithTrace, updateTraceContext } from '../src/trace.js';
import type { TraceContext } from '../src/trace.js';

/** Collects every line the logger writes, parsed. */
function capture(): { lines: Record<string, unknown>[]; stream: { write(s: string): void } } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    stream: {
      write(s: string) {
        lines.push(JSON.parse(s) as Record<string, unknown>);
      },
    },
  };
}

function testLogger(destination: { write(s: string): void }) {
  return createLogger({ name: 'test', level: 'trace', destination });
}

function trace(over: Partial<TraceContext> = {}): TraceContext {
  return { requestId: newRequestId(), traceId: newTraceId(), ...over };
}

describe('redaction', () => {
  it('redacts a password field', () => {
    const { lines, stream } = capture();
    testLogger(stream).info({ password: 'hunter2' }, 'login attempt');
    expect(lines[0]?.['password']).toBe('[REDACTED]');
    expect(JSON.stringify(lines[0])).not.toContain('hunter2');
  });

  it('redacts connection strings, which carry user:password@host', () => {
    const { lines, stream } = capture();
    testLogger(stream).info(
      { DATABASE_URL: 'postgres://relayd:s3cr3t@db.internal:5432/relayd' },
      'connecting',
    );
    expect(JSON.stringify(lines[0])).not.toContain('s3cr3t');
  });

  it('redacts an authorization header one level down', () => {
    const { lines, stream } = capture();
    testLogger(stream).info({ headers: { authorization: 'Bearer abc.def' } }, 'request');
    expect(JSON.stringify(lines[0])).not.toContain('abc.def');
  });

  it('never emits a credential canary through any redacted path', () => {
    const canary = 'SECRET-CANARY-9f3a';
    const { lines, stream } = capture();
    const log = testLogger(stream);
    log.error({ smtpPassword: canary }, 'smtp auth failed');
    log.error({ connection: { credentials: canary } }, 'provider rejected');
    log.error({ apiKey: canary }, 'key rejected');
    expect(JSON.stringify(lines)).not.toContain(canary);
  });
});

describe('trace context', () => {
  it('is undefined outside any traced scope', () => {
    const { lines, stream } = capture();
    testLogger(stream).info('no trace here');
    expect(lines[0]?.['requestId']).toBeUndefined();
  });

  it('lands on every line without the call site adding it', () => {
    const { lines, stream } = capture();
    const log = testLogger(stream);
    const ctx = trace({ workspaceId: 'ws_1' });
    runWithTrace(ctx, () => {
      log.info('first');
      log.info('second');
    });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line['requestId']).toBe(ctx.requestId);
      expect(line['traceId']).toBe(ctx.traceId);
      expect(line['workspaceId']).toBe('ws_1');
    }
  });

  it('survives an await boundary', async () => {
    const { lines, stream } = capture();
    const log = testLogger(stream);
    const ctx = trace();
    await runWithTrace(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      log.info('after await');
    });
    expect(lines[0]?.['requestId']).toBe(ctx.requestId);
  });

  it('picks up identifiers discovered mid-request', () => {
    const { lines, stream } = capture();
    const log = testLogger(stream);
    runWithTrace(trace(), () => {
      log.info('before auth');
      updateTraceContext({ workspaceId: 'ws_2', userId: 'u_1' });
      log.info('after auth');
    });
    expect(lines[0]?.['workspaceId']).toBeUndefined();
    expect(lines[1]?.['workspaceId']).toBe('ws_2');
    expect(lines[1]?.['userId']).toBe('u_1');
  });

  it('does not throw when updating outside a traced scope', () => {
    expect(() => updateTraceContext({ workspaceId: 'ws_3' })).not.toThrow();
  });

  it('keeps concurrent requests separate', async () => {
    const { lines, stream } = capture();
    const log = testLogger(stream);
    const a = trace({ workspaceId: 'ws_a' });
    const b = trace({ workspaceId: 'ws_b' });
    await Promise.all([
      runWithTrace(a, async () => {
        await new Promise((r) => setTimeout(r, 2));
        log.info('a');
      }),
      runWithTrace(b, async () => {
        log.info('b');
      }),
    ]);
    const byMsg = new Map(lines.map((l) => [l['msg'], l]));
    expect(byMsg.get('a')?.['workspaceId']).toBe('ws_a');
    expect(byMsg.get('b')?.['workspaceId']).toBe('ws_b');
  });
});

describe('level formatting', () => {
  it('writes the level as a string for log-query readability', () => {
    const { lines, stream } = capture();
    testLogger(stream).warn('degraded');
    expect(lines[0]?.['level']).toBe('warn');
  });
});
