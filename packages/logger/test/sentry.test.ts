import { describe, expect, it } from 'vitest';
import { beforeSend, scrubValue } from '../src/sentry.js';

/**
 * The Sentry denylist (INVARIANTS R22).
 *
 * Sentry is a separate exfiltration path from the logs, with its own
 * serialiser and generous defaults. The canary below is the invariant's own
 * test value.
 */
const CANARY = 'SECRET-CANARY-9f3a';

/** Everything in a Sentry event that a credential can ride out on. */
function eventCarrying(secret: string) {
  return {
    event_id: 'abc',
    message: `Request failed with api_key=${secret}`,
    request: {
      url: 'https://api.relayd.test/v1/providers',
      headers: {
        Authorization: `Bearer ${secret}`,
        cookie: `session=${secret}`,
        'user-agent': 'relayd/1.0',
      },
    },
    extra: {
      credentials: { secretAccessKey: secret },
      connectionString: `postgres://user:${secret}@db:5432/relayd`,
      note: 'this one is fine',
    },
    contexts: {
      provider: { smtpPassword: secret, host: 'smtp.example.com' },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `Invalid login smtps://postmaster:${secret}@smtp.example.com:465`,
          mechanism: { data: { apiKey: secret } },
        },
      ],
    },
    breadcrumbs: [
      { category: 'http', message: `GET https://x.test?token=${secret}`, data: { token: secret } },
    ],
  };
}

describe('the canary never reaches Sentry', () => {
  it('is absent from every part of a realistic event', () => {
    const scrubbed = beforeSend(eventCarrying(CANARY));
    expect(JSON.stringify(scrubbed)).not.toContain(CANARY);
  });

  it('censors by key name wherever the key appears', () => {
    const scrubbed = beforeSend({
      a: { b: { c: { password: CANARY, apiKey: CANARY, harmless: 'keep me' } } },
    }) as { a: { b: { c: Record<string, string> } } };

    expect(scrubbed.a.b.c['password']).toBe('[REDACTED]');
    expect(scrubbed.a.b.c['apiKey']).toBe('[REDACTED]');
    expect(scrubbed.a.b.c['harmless']).toBe('keep me');
  });

  it('censors by value shape even under an innocent key name', () => {
    // The key that leaks is rarely called "password". It is called "url",
    // "detail", or "response".
    const scrubbed = beforeSend({
      detail: 'connecting to smtps://user:hunter2hunter2@smtp.example.com:465 failed',
      note: 'AKIAIOSFODNN7EXAMPLE was rejected',
      stripe: 'sk_live_abcdefghijklmnop rejected',
    }) as Record<string, string>;

    expect(scrubbed['detail']).not.toContain('hunter2hunter2');
    expect(scrubbed['note']).toContain('[REDACTED]');
    expect(scrubbed['stripe']).toContain('[REDACTED]');
  });

  it('keeps the parts of an event that make it useful', () => {
    // A scrubber that empties the event is a scrubber that gets turned off.
    const scrubbed = beforeSend(eventCarrying(CANARY)) as Record<string, unknown>;

    expect(scrubbed['event_id']).toBe('abc');
    expect((scrubbed['request'] as { headers: Record<string, string> }).headers['user-agent']).toBe(
      'relayd/1.0',
    );
    expect((scrubbed['extra'] as Record<string, string>)['note']).toBe('this one is fine');
    expect(
      (scrubbed['contexts'] as { provider: Record<string, string> }).provider['host'],
    ).toBe('smtp.example.com');
  });
});

describe('it cannot be made to hang or throw', () => {
  it('survives a cycle', () => {
    // A Sentry event can contain an error whose cause points back at it.
    const event: Record<string, unknown> = { name: 'outer' };
    event['self'] = event;

    const scrubbed = beforeSend(event) as Record<string, unknown>;
    expect(scrubbed['self']).toBe('[circular]');
  });

  it('truncates rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { password: CANARY };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    expect(JSON.stringify(beforeSend(deep))).not.toContain(CANARY);
  });

  it('bounds a very wide object', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i += 1) wide[`k${i}`] = i;

    const scrubbed = beforeSend(wide) as Record<string, unknown>;
    expect(Object.keys(scrubbed).length).toBeLessThanOrEqual(200);
  });

  it('drops the event rather than sending it unscrubbed if scrubbing fails', () => {
    // A missing error report is a smaller problem than a leaked credential,
    // and the log line is still there.
    const hostile = {
      get boom(): never {
        throw new Error('nope');
      },
    };

    expect(beforeSend(hostile)).toBeNull();
  });

  it('leaves an event with nothing sensitive alone', () => {
    const plain = { event_id: 'x', message: 'campaign launched', extra: { count: 5 } };
    expect(beforeSend(plain)).toEqual(plain);
  });
});

describe('value scrubbing', () => {
  it('catches the credential shapes that appear in prose', () => {
    expect(scrubValue('postgres://u:p4ssw0rd@db:5432/x')).toContain('[REDACTED]');
    expect(scrubValue('Authorization: Bearer abcdefghijklmnop')).toContain('[REDACTED]');
    expect(scrubValue('key AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
    expect(scrubValue('whsec_abcdefghijklmnop')).toContain('[REDACTED]');
  });

  it('leaves ordinary text alone', () => {
    const message = 'Campaign 42 finished with 1,203 delivered and 4 bounced';
    expect(scrubValue(message)).toBe(message);
  });
});
