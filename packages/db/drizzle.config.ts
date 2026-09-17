import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit generates SQL; a human then edits it and commits it as an
 * immutable numbered file (docs/01, "Migration discipline"). Generation is
 * offline and needs no database connection, which is also why this file reads
 * no environment — process.env is confined to packages/config.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle-generated',
  casing: 'snake_case',
});
