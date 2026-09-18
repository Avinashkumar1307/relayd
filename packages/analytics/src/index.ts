// @relayd/analytics — rollups and metric definitions.
export {
  RATE_DEFINITIONS,
  HEADLINE_RATE,
  RECENCY_FULL_DAYS,
  RECENCY_ZERO_DAYS,
  RECENCY_FLOOR,
  rate,
  engagementScore,
  recencyFactor,
} from './rollup/metrics.js';
export type { Rate, RateKind, RateDefinition } from './rollup/metrics.js';

export {
  runIncremental,
  runHourly,
  rollContactEngagement,
  HOURLY_WINDOW_MS,
} from './rollup/rollup.js';
export type {
  RollupPort,
  EventCounts,
  DispatchCounts,
  IncrementalResult,
  HourlyResult,
} from './rollup/rollup.js';

export {
  ensurePartitions,
  partitionsAreHealthy,
  monthsToCover,
  partitionNameFor,
  PARTITION_LEAD_DAYS,
  PARTITIONED_TABLES,
} from './rollup/partitions.js';
export type { PartitionPort, PartitionResult, PartitionedTable } from './rollup/partitions.js';

export { dayBucket, willBeCounted, backfillWindowFor, daysInWindow } from './rollup/buckets.js';
