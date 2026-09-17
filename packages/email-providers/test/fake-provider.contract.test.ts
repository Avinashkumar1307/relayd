import { describe } from 'vitest';
import { runProviderContract, type ContractHarness } from '../src/testing/contract.js';
import { createFakeProvider, signFakeWebhook } from '../src/testing/fake-provider.js';
import type { ErrorKind, ProviderCredentials } from '../src/port.js';

/**
 * The contract suite, run against the fake.
 *
 * Proves the suite is passable before any real adapter is measured by it. A
 * contract nothing can satisfy is a contract that gets weakened the first time
 * it is inconvenient.
 */

const SECRET = 'whsec_fake_contract';

const WEBHOOK_BODY = Buffer.from(
  JSON.stringify([
    { id: 'evt-1', type: 'delivered', email: 'a@example.com', at: '2026-01-01T10:00:00.000Z', messageId: 'pm-a' },
    { id: 'evt-2', type: 'bounce', email: 'b@example.com', at: '2026-01-01T10:01:00.000Z', bounceClass: 'hard' },
  ]),
  'utf8',
);

describe('fake provider', () => {
  runProviderContract((): ContractHarness => {
    // The canary stands in for a real credential; the suite asserts it never
    // reaches a serialised outcome.
    const credentials: ProviderCredentials = { type: 'sendgrid', apiKey: 'SECRET-CANARY-9f3a' };

    let failure: ErrorKind | null = null;
    let hang = false;

    const build = () =>
      createFakeProvider({
        ...(failure === null ? {} : { failures: { r1: failure }, verificationFails: failure === 'auth_failed' }),
        hang,
      });

    let adapter = build();

    return {
      name: 'fake',
      credentials,

      // A getter, so scriptFailure can rebuild the adapter and the suite
      // still sees the current one.
      get adapter() {
        return adapter;
      },

      scriptFailure(kind: ErrorKind): boolean {
        failure = kind;
        adapter = build();
        return true;
      },

      scriptHang(): void {
        hang = true;
        adapter = build();
      },

      reset(): void {
        failure = null;
        hang = false;
        adapter = build();
      },

      webhook: {
        body: WEBHOOK_BODY,
        headers: { 'x-fake-signature': signFakeWebhook(WEBHOOK_BODY, SECRET) },
        secret: SECRET,
        expectedEvents: 2,
      },
    };
  });
});
