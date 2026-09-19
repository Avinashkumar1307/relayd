// @relayd/queue — BullMQ setup, typed job definitions, queue settings.
export { createRedisConnection, createBullConnection, pingRedis } from './connection.js';
export type { CreateRedisOptions, RedisConnection } from './connection.js';
export {
  QUEUE_NAMES,
  QUEUE_SETTINGS,
  CRITICAL_QUEUES,
  jobOptionsFor,
  workerOptionsFor,
  jobIds,
} from './queues.js';
export type { QueueName, QueueSettings, BackoffSettings } from './queues.js';
export {
  handleFailedJob,
  replayDeadLetter,
  serialiseError,
  workspaceIdOf,
} from './dead-letters.js';
export type {
  FailedJob,
  DeadLetterRecord,
  DeadLetterSink,
  DeadLetterDeps,
  ReplayTarget,
  ReplayableDeadLetter,
} from './dead-letters.js';
export { withTrace, resumeTrace, withoutTrace, TRACE_FIELD } from './trace.js';
export type { Traced } from './trace.js';
export { GLOBAL_JOB_TYPES, isGlobalJob } from './global-jobs.js';
