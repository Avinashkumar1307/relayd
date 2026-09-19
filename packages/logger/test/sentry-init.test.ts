import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Sentry wiring (docs/10 "Observability"; INVARIANTS R22, finding F22).
 *
 * `sentry.ts` holds the scrubber and is tested on its own. What is tested
 * here is the wiring, and the reason it needs its own tests is that every
 * failure mode is silent:
 *
 *   A `beforeSend` that was never attached ships provider errors — including
 *   the nodemailer connection URL with the password in it — to a third
 *   party. Nothing about the running system looks wrong; error reporting
 *   works better than ever.
 *
 *   A `tracesSampler` that returns 0 for billing operations satisfies every
 *   functional test and quietly discards the traces docs/10 asks to keep at
 *   100%.
 *
 * So these assert on the options object handed to the SDK, which is the only
 * place the answer exists before an incident.
 */

const init = vi.fn();
const flush = vi.fn(async () => true);
const captureException = vi.fn();
const setTags = vi.fn();

vi.mock('@sentry/node', () => ({
  init,
  flush,
  captureException,
  getCurrentScope: () => ({ setTags }),
}));

async function freshModule() {
  vi.resetModules();
  return import('../src/sentry-init.js');
}

afterEach(() => {
  vi.clearAllMocks();
});

const base = { environment: 'production', process: 'api', dsn: 'https://k@example.test/1' };

describe('initSentry', () => {
  it('does nothing without a DSN, and says so', async () => {
    // Local development and the test suite. Returning false rather than
    // throwing means an entrypoint can log the difference between "error
    // reporting is on" and "error reporting is off because nobody set a
    // DSN", which are otherwise indistinguishable until the first incident.
    const { initSentry } = await freshModule();

    expect(initSentry({ ...base, dsn: undefined })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('treats an empty DSN as absent', async () => {
    // An unset environment variable arrives as '' more often than as
    // undefined, and Sentry's own init throws on an empty string.
    const { initSentry } = await freshModule();

    expect(initSentry({ ...base, dsn: '' })).toBe(false);
    expect(init).not.toHaveBeenCalled();
  });

  it('always attaches the scrubber', async () => {
    const { initSentry } = await freshModule();
    initSentry(base);

    const options = init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof options['beforeSend']).toBe('function');
  });

  it('scrubs breadcrumbs too', async () => {
    // The quiet leak. A fetch breadcrumb carries the URL, and a Secrets
    // Manager URL names a workspace and a connection. Breadcrumbs do not go
    // through beforeSend.
    const { initSentry } = await freshModule();
    initSentry(base);

    const options = init.mock.calls[0]?.[0] as Record<string, unknown>;
    const beforeBreadcrumb = options['beforeBreadcrumb'] as (b: unknown) => unknown;

    expect(typeof beforeBreadcrumb).toBe('function');
    expect(beforeBreadcrumb({ message: 'token=abcdef123456' })).toEqual({
      message: expect.not.stringContaining('abcdef123456') as unknown as string,
    });
  });

  it('keeps PII off explicitly', async () => {
    // The default is already false. It is set anyway, because a future SDK
    // major flipping that default would be a silent leak.
    const { initSentry } = await freshModule();
    initSentry(base);

    const options = init.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options['sendDefaultPii']).toBe(false);
  });

  it('tags the process so an error points at one of the four', async () => {
    const { initSentry } = await freshModule();
    initSentry({ ...base, process: 'worker' });

    const options = init.mock.calls[0]?.[0] as { initialScope?: { tags?: { process?: string } } };
    expect(options.initialScope?.tags?.process).toBe('worker');
  });

  it('starts once', async () => {
    const { initSentry } = await freshModule();

    expect(initSentry(base)).toBe(true);
    expect(initSentry(base)).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe('the traces sampler', () => {
  it('samples billing operations at 100%', async () => {
    // docs/10: "sampled 5%, 100% on errors and all billing operations."
    const { tracesSampler, DEFAULT_TRACES_SAMPLE_RATE } = await freshModule();
    const sample = tracesSampler(DEFAULT_TRACES_SAMPLE_RATE);

    expect(sample({ name: 'POST /ingest/v1/stripe' })).toBe(1);
    expect(sample({ name: 'GET /api/v1/billing/subscription' })).toBe(1);
    expect(sample({ name: 'billing-reconcile' })).toBe(1);
  });

  it('samples everything else at the configured rate', async () => {
    const { tracesSampler } = await freshModule();

    expect(tracesSampler(0.05)({ name: 'GET /api/v1/contacts' })).toBe(0.05);
  });

  it('defaults to the rate docs/10 names', async () => {
    const { DEFAULT_TRACES_SAMPLE_RATE } = await freshModule();

    expect(DEFAULT_TRACES_SAMPLE_RATE).toBe(0.05);
  });

  it('honours an upstream decision so a trace is not half-recorded', async () => {
    // If the api sampled a request in, the worker job it enqueued should be
    // in too. A trace with the middle missing is worse than no trace: it
    // looks like the work never happened.
    const { tracesSampler } = await freshModule();
    const sample = tracesSampler(0.05);

    expect(sample({ name: 'send', parentSampled: true })).toBe(1);
    expect(sample({ name: 'send', parentSampled: false })).toBe(0);
  });

  it('lets an always-sampled name override a parent that said no', async () => {
    // Billing is 100% unconditionally. A parent request sampled out must not
    // drag a billing operation out with it.
    const { tracesSampler } = await freshModule();

    expect(tracesSampler(0.05)({ name: 'billing-reconcile', parentSampled: false })).toBe(1);
  });

  it('does not match a name that merely contains a billing word', async () => {
    // `shouldAlwaysSample` is anchored. Without anchoring, a route named
    // `/api/v1/campaigns` would be fine but `/api/v1/unbilling` would be
    // sampled at 100%, and the cost of over-sampling shows up as a bill
    // nobody can explain.
    const { shouldAlwaysSample } = await freshModule();

    expect(shouldAlwaysSample('GET /api/v1/contacts')).toBe(false);
    expect(shouldAlwaysSample(undefined)).toBe(false);
  });
});

describe('capture and flush', () => {
  it('captures nothing when Sentry never started', async () => {
    const { captureError } = await freshModule();

    captureError(new Error('boom'));
    expect(captureException).not.toHaveBeenCalled();
  });

  it('captures once started', async () => {
    const { initSentry, captureError } = await freshModule();
    initSentry(base);

    captureError(new Error('boom'));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('flushes on shutdown', async () => {
    // A worker's SIGTERM drain window is where the errors that matter most
    // are thrown, and without a flush they sit in a buffer inside a process
    // that is about to stop existing.
    const { initSentry, flushSentry } = await freshModule();
    initSentry(base);

    await flushSentry(1_000);
    expect(flush).toHaveBeenCalledWith(1_000);
  });

  it('resolves immediately when Sentry never started', async () => {
    const { flushSentry } = await freshModule();

    await expect(flushSentry()).resolves.toBe(true);
    expect(flush).not.toHaveBeenCalled();
  });
});
