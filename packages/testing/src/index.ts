// @relayd/testing — factories, containers, fake gateways, contract suites.
export {
  startPostgres,
  startRedis,
  isDockerAvailable,
  isCI,
  requireContainers,
} from './containers.js';
export type { StartedPostgres, StartedRedis, IntegrationGate } from './containers.js';
export { extractRollback } from './rollback.js';
export {
  scanRepository,
  scanSource,
  collectSourceFiles,
  blankComments,
  SCOPE_OWNER,
} from './workspace-scope-scan.js';
export type { ScopeViolation, ViolationKind } from './workspace-scope-scan.js';
