import { baseEnv, parseEnv, workerEntrypointEnv } from '@relayd/config';
import { createLogger } from '@relayd/logger';
import { runEntrypoint, type WorkerEntrypoint } from './harness.js';
import { entrypoint as billing } from './entrypoints/billing.js';
import { entrypoint as campaign } from './entrypoints/campaign.js';
import { entrypoint as events } from './entrypoints/events.js';
import { entrypoint as io } from './entrypoints/io.js';
import { entrypoint as send } from './entrypoints/send.js';

/**
 * ONE worker app with five entrypoints, not five apps (CLAUDE.md section 3).
 *
 * docs/13 gives the reasoning: five apps means five package.json files, five
 * Dockerfiles and five dependency trees that drift. Five ECS services running
 * the same image with a different RELAYD_WORKER_ENTRYPOINT gives identical
 * deployment isolation from one build.
 */
const ENTRYPOINTS: Record<string, WorkerEntrypoint> = {
  send,
  campaign,
  events,
  billing,
  io,
};

const env = parseEnv(baseEnv.merge(workerEntrypointEnv));
const logger = createLogger({ name: `worker:${env.RELAYD_WORKER_ENTRYPOINT}`, level: env.LOG_LEVEL });

const selected = ENTRYPOINTS[env.RELAYD_WORKER_ENTRYPOINT];
if (selected === undefined) {
  // Unreachable: the Zod enum has already rejected anything else.
  throw new Error(`Unknown worker entrypoint: ${env.RELAYD_WORKER_ENTRYPOINT}`);
}

await runEntrypoint({ entrypoint: selected, logger });
