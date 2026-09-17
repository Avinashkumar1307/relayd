import type { WorkerEntrypoint } from '../harness.js';

/**
 * send — the email-send queue: the guarded transition, the limiter and the provider call (Phase 6)
 *
 * Registers no consumers yet. Queues are declared with their explicit
 * settings in Phase 5 (CLAUDE.md section 9: concurrency, lockDuration,
 * attempts, backoff and both removal bounds; defaults are never accepted),
 * and the consumers themselves arrive with the phases above.
 */
export const entrypoint: WorkerEntrypoint = {
  name: 'send',
  start: async () => {
    // Consumers are registered here.
  },
  stop: async () => {
    // Each registered consumer is closed here, which waits for in-flight jobs.
  },
};
