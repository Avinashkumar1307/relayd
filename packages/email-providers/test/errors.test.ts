import { describe, expect, it } from 'vitest';
import {
  classifyStatus,
  fromUnknown,
  parseRetryAfter,
  providerError,
  redact,
  secretsOf,
} from '../src/errors.js';
import { ERROR_POLICY, type ErrorKind } from '../src/port.js';

/**
 * The scrubbing boundary (INVARIANTS R22, review finding F22).
 *
 * The canary below is the invariant's own test value. It stands in for a real
 * customer credential: if it can reach a serialised error, so can an SMTP
 * password.
 */
const CANARY = 'SECRET-CANARY-9f3a';

describe('the credential canary never survives', () => {
  const carriers: { name: string; thrown: unknown }[] = [
    {
      name: 'a nodemailer-style SMTP error with the connection URL',
      thrown: Object.assign(new Error(`Invalid login: 535 auth failed`), {
        code: 'EAUTH',
        // Nodemailer really does attach this.
        response: `535 5.7.8 Error: authentication failed`,
        command: 'AUTH PLAIN',
        url: `smtps://postmaster:${CANARY}@smtp.example.com:465`,
      }),
    },
    {
      name: 'an SDK error carrying the Authorization header',
      thrown: Object.assign(new Error('Request failed'), {
        status: 401,
        config: { headers: { Authorization: `Bearer ${CANARY}` } },
      }),
    },
    {
      name: 'an error whose message interpolates the key',
      thrown: new Error(`Request to SES failed: api_key=${CANARY} was rejected`),
    },
    {
      name: 'a plain string',
      thrown: `connection refused for smtp://user:${CANARY}@host`,
    },
    {
      name: 'an object with the secret in a nested field',
      thrown: { statusCode: 403, body: { credentials: { secretAccessKey: CANARY } } },
    },
  ];

  for (const { name, thrown } of carriers) {
    it(`is absent after scrubbing ${name}`, () => {
      const error = fromUnknown(thrown);

      // Every representation the error could reach a log or Sentry through.
      const surfaces = [
        JSON.stringify(error),
        String(error.message),
        Object.values(error).join(' '),
        `${error.kind} ${error.message} ${error.providerCode ?? ''}`,
      ];

      for (const surface of surfaces) {
        expect(surface, `${name} via ${surface.slice(0, 40)}`).not.toContain(CANARY);
      }
    });
  }

  it('keeps nothing from the original object', () => {
    const thrown = Object.assign(new Error('nope'), {
      status: 401,
      secretAccessKey: CANARY,
      config: { auth: { pass: CANARY } },
    });

    const error = fromUnknown(thrown);

    // The guarantee is reconstruction, not filtering: the result has exactly
    // the fields ProviderError declares and nothing else.
    expect(Object.keys(error).sort()).toEqual(
      ['affects', 'kind', 'message', 'retryable'].sort(),
    );
  });

  it('redacts a credential that an adapter interpolated by hand', () => {
    // Belt and braces for the case reconstruction cannot catch: a message
    // built by a future adapter out of something it should not have used.
    expect(redact(`auth failed for api_key=${CANARY}`)).not.toContain(CANARY);
    expect(redact(`smtps://u:${CANARY}@h:465`)).not.toContain(CANARY);
    expect(redact(`Authorization: Bearer ${CANARY}`)).not.toContain(CANARY);
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[redacted]');
    expect(redact('SG.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb')).toBe('[redacted]');
  });

  it('leaves an ordinary message readable', () => {
    // A scrubber that redacts everything is a scrubber nobody can debug with.
    const message = 'The recipient address was rejected: mailbox does not exist';
    expect(redact(message)).toBe(message);
  });
});

describe('classification', () => {
  it('maps the statuses providers actually return', () => {
    expect(classifyStatus(401)).toBe('auth_failed');
    expect(classifyStatus(403)).toBe('auth_failed');
    expect(classifyStatus(413)).toBe('message_too_large');
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(408)).toBe('timeout');
    expect(classifyStatus(500)).toBe('provider_unavailable');
    expect(classifyStatus(503)).toBe('provider_unavailable');
    expect(classifyStatus(422)).toBe('content_rejected');
  });

  it('reads a socket error code', () => {
    expect(fromUnknown({ code: 'ETIMEDOUT' }).kind).toBe('timeout');
    expect(fromUnknown({ code: 'ECONNREFUSED' }).kind).toBe('provider_unavailable');
    expect(fromUnknown({ code: 'ENOTFOUND' }).kind).toBe('provider_unavailable');
  });

  it('treats an aborted request as a timeout, not a failure', () => {
    // It may have been accepted. Calling it a failure is how a list gets the
    // same email twice.
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    expect(fromUnknown(aborted).kind).toBe('timeout');
  });

  it('finds a status on a nested response object', () => {
    expect(fromUnknown({ response: { status: 429 } }).kind).toBe('rate_limited');
  });

  it('falls back to unknown, which is retryable', () => {
    // An adapter that threw for a reason nobody anticipated is not evidence
    // that the recipient is bad.
    const error = fromUnknown(new Error('something odd'));
    expect(error.kind).toBe('unknown');
    expect(error.retryable).toBe(true);
  });

  it('passes an already-typed error through unchanged', () => {
    const original = providerError('invalid_recipient', 'no such mailbox');
    expect(fromUnknown(original)).toBe(original);
  });
});

describe('the policy table is the single source of truth', () => {
  it('takes retryable and affects from the policy, not from the caller', () => {
    // An adapter must not be able to declare an auth failure retryable and
    // put a connection into a retry loop with a wrong password.
    const error = providerError('auth_failed', 'bad key');
    expect(error.retryable).toBe(false);
    expect(error.affects).toBe('connection');
  });

  it('covers every ErrorKind', () => {
    const kinds: ErrorKind[] = [
      'auth_failed',
      'rate_limited',
      'quota_exceeded',
      'invalid_recipient',
      'invalid_sender',
      'content_rejected',
      'message_too_large',
      'provider_unavailable',
      'timeout',
      'unknown',
    ];

    expect(Object.keys(ERROR_POLICY).sort()).toEqual([...kinds].sort());
  });

  it('suppresses only for an invalid recipient', () => {
    // docs/07: a bounce suppresses; a rejected subject line does not. Getting
    // this wrong permanently removes a contact because of one bad template.
    const suppressing = Object.entries(ERROR_POLICY)
      .filter(([, policy]) => policy.suppress !== false)
      .map(([kind]) => kind);

    expect(suppressing).toEqual(['invalid_recipient']);
  });

  it('leaves a timeout ambiguous rather than failing it', () => {
    expect(ERROR_POLICY.timeout.recipient).toBe('sending');
    expect(ERROR_POLICY.timeout.suppress).toBe(false);
  });

  it('never marks a permanent failure retryable', () => {
    for (const kind of ['invalid_recipient', 'content_rejected', 'message_too_large'] as const) {
      expect(ERROR_POLICY[kind].retryable, kind).toBe(false);
      expect(ERROR_POLICY[kind].recipient, kind).toBe('failed');
    }
  });
});

describe('Retry-After', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('gives up rather than guessing', () => {
    // Guessing a backoff when the provider said something we cannot read is
    // how a rate limit becomes a ban.
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('redacting the credential actually in use', () => {
  it('removes a secret the patterns would never recognise', () => {
    // The patterns are guesses about shape. A provider that echoes the key
    // back inside its own prose defeats every one of them — and is defeated
    // by knowing what the key is.
    const odd = 'hunter2-but-longer';
    expect(redact(`Bad key ${odd} rejected`, [odd])).not.toContain(odd);
  });

  it('is applied by providerError when the caller supplies it', () => {
    const error = providerError('auth_failed', `rejected key ${CANARY}`, { secrets: [CANARY] });
    expect(error.message).not.toContain(CANARY);
  });

  it('redacts it out of the provider code too', () => {
    const error = providerError('unknown', 'x', { providerCode: CANARY, secrets: [CANARY] });
    expect(error.providerCode).not.toContain(CANARY);
  });

  it('ignores a secret too short to be one', () => {
    // A two-character password would match everywhere and redact the message
    // into uselessness.
    expect(redact('a cat sat on a mat', ['at'])).toBe('a cat sat on a mat');
  });

  it('finds the credential material in every credential shape', () => {
    expect(secretsOf({ type: 'sendgrid', apiKey: 'k1' })).toEqual(['k1']);
    expect(
      secretsOf({ type: 'ses', accessKeyId: 'a1', secretAccessKey: 's1', region: 'eu-west-1' }),
    ).toEqual(['s1', 'a1']);
    expect(
      secretsOf({ type: 'smtp', host: 'h', port: 1, secure: false, user: 'u', pass: 'p1' }),
    ).toEqual(['p1']);
    expect(secretsOf({ type: 'google', refreshToken: 'r1', clientId: 'c', clientSecret: 's2' })).toEqual([
      'r1',
      's2',
    ]);
  });

  it('never returns a non-secret field such as a host or region', () => {
    const secrets = secretsOf({ type: 'smtp', host: 'smtp.example.com', port: 587, secure: true, user: 'u', pass: 'p1' });
    expect(secrets).not.toContain('smtp.example.com');
  });
});
