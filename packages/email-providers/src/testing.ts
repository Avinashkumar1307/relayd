/**
 * Test support for the provider port, behind its own entry point.
 *
 * These were exported from the package's main barrel, which meant anything
 * importing a *value* from `@relayd/email-providers` — `ERROR_POLICY`, say —
 * loaded `testing/contract.ts`, which imports `vitest` at module scope. The
 * API crashed on boot with "Vitest failed to access its internal state" the
 * first time production code did so. A test harness in a production entry
 * point is a runtime dependency on a devDependency; the subpath keeps it
 * reachable from tests and unreachable from a running process.
 */
export { createFakeProvider, signFakeWebhook } from './testing/fake-provider.js';
export type { FakeProvider, FakeProviderScript } from './testing/fake-provider.js';
export { runProviderContract, outboundMessage } from './testing/contract.js';
export type { ContractHarness } from './testing/contract.js';
