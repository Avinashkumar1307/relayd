// @relayd/db — Drizzle schema, migrations, repositories.
// The ONLY place db.* is called (CLAUDE.md section 6.1).
export { createPool, createDatabase } from './client.js';
export type { Database, CreatePoolOptions } from './client.js';
export { scoped, workspaceScope } from './scope.js';
export type { WorkspaceScope } from './scope.js';
export { uuidv7 } from './uuid.js';
export { runMigrations, readMigrations, MigrationError } from './migrate.js';
export type {
  MigrationFile,
  MigrationEvent,
  MigrationsResult,
  RunMigrationsOptions,
} from './migrate.js';
