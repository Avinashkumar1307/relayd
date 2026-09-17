import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEnv, EnvironmentError, parseEnv, postgresEnv } from '@relayd/config';
import { createLogger } from '@relayd/logger';
import { runMigrations } from '../migrate.js';

/**
 * `pnpm db:migrate`, and the one-off ECS task that runs before a service
 * update. Never invoked at container boot (CLAUDE.md section 12).
 */
/**
 * Configuration failures happen before there is a logger to report them, and
 * this runs as a one-off ECS task whose only output is the task log. A raw
 * stack trace there costs an operator minutes; the message alone is the whole
 * diagnosis. process.stderr rather than console, which the no-console rule
 * bans and which would bypass the logger's redaction everywhere else.
 */
function fail(message: string): never {
  process.stderr.write(`${message}
`);
  process.exit(1);
}

let env;
try {
  env = parseEnv(baseEnv.merge(postgresEnv));
} catch (error) {
  if (error instanceof EnvironmentError) {
    fail(error.message);
  }
  throw error;
}

const logger = createLogger({ name: 'db:migrate', level: env.LOG_LEVEL });

const here = path.dirname(fileURLToPath(import.meta.url));
const directory = path.resolve(here, '../../migrations');

try {
  const result = await runMigrations({
    connectionString: env.DATABASE_URL,
    directory,
    log: (event) => {
      switch (event.kind) {
        case 'start':
          logger.info(
            { pending: event.pending, alreadyApplied: event.alreadyApplied },
            'migration run started',
          );
          break;
        case 'applied':
          logger.info({ migration: event.name, durationMs: event.durationMs }, 'migration applied');
          break;
        case 'done':
          logger.info(
            { applied: event.applied, alreadyApplied: event.alreadyApplied },
            event.applied === 0 ? 'no migrations pending' : 'migration run complete',
          );
          break;
      }
    },
  });

  if (result.applied.length === 0) {
    logger.info('database is up to date');
  }
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'migration run failed');
  process.exit(1);
}
