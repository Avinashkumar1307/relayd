import { baseEnv, parseEnv, postgresDirectEnv } from '@relayd/config';
import { createDirectClient } from '@relayd/db';
import { createLogger } from '@relayd/logger';
import { Scheduler } from './scheduler.js';

const env = parseEnv(baseEnv.merge(postgresDirectEnv));
const logger = createLogger({ name: 'scheduler', level: env.LOG_LEVEL });

// DATABASE_DIRECT_URL, never DATABASE_URL: this process must reach Postgres
// directly and never through PgBouncer (INVARIANTS R35).
const client = createDirectClient(env.DATABASE_DIRECT_URL);
const scheduler = new Scheduler({ client, logger });

await scheduler.start();
logger.info('scheduler started');

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  void scheduler
    .stop()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    });
};

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
