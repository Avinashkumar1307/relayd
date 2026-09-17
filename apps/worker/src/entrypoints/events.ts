import type { WorkerEntrypoint } from '../harness.js';

/**
 * events — event-ingest and analytics-rollup: provider callbacks and rollups (Phases 6 and 7)
 *
 * Registers no consumers yet. Queues are declared with their explicit
 * settings in Phase 5 (CLAUDE.md section 9: concurrency, lockDuration,
 * attempts, backoff and both removal bounds; defaults are never accepted),
 * and the consumers themselves arrive with the phases above.
 */
export const entrypoint: WorkerEntrypoint = {
  name: 'events',
  start: async () => {
    // Consumers are registered here.
  },
  stop: async () => {
    // Each registered consumer is closed here, which waits for in-flight jobs.
  },
};
