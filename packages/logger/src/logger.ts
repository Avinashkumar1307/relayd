import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { REDACTION_CENSOR, REDACTION_PATHS } from './redaction.js';
import { getTraceContext } from './trace.js';

export type { Logger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface CreateLoggerOptions {
  /** Process name: api, edge, worker, scheduler. Appears on every line. */
  name: string;
  level: LogLevel;
  /**
   * Where lines are written. Defaults to stdout, which is what every process
   * uses: Fargate ships stdout to CloudWatch Logs. Tests pass a stream.
   */
  destination?: DestinationStream;
}

/**
 * Builds the process logger.
 *
 * Structured fields only, never interpolated strings (CLAUDE.md section 6.6):
 *   logger.info({ campaignId, recipientCount }, 'campaign dispatch started')
 * not
 *   logger.info(`campaign ${campaignId} started`)
 *
 * The mixin means the ambient trace context lands on every line without any
 * call site remembering to add it.
 */
export function createLogger(options: CreateLoggerOptions): Logger {
  const base: LoggerOptions = {
    name: options.name,
    level: options.level,
    redact: {
      paths: [...REDACTION_PATHS],
      censor: REDACTION_CENSOR,
    },
    mixin() {
      return getTraceContext() ?? {};
    },
    formatters: {
      // CloudWatch Logs Insights filters on `level` as a string far more
      // readably than on pino's default numeric level.
      level(label) {
        return { level: label };
      },
    },
  };

  return options.destination === undefined
    ? pino(base)
    : pino(base, options.destination);
}
