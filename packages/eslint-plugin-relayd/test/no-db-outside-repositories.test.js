import rule from '../src/rules/no-db-outside-repositories.js';
import { posix, ruleTester, windows } from './harness.js';

ruleTester.run('no-db-outside-repositories', rule, {
  valid: [
    {
      name: 'db.select inside a repository',
      filename: posix('packages/db/repositories/campaigns.ts'),
      code: 'const rows = await db.select().from(campaigns);',
    },
    {
      name: 'db.select inside a repository, src/ layout',
      filename: posix('packages/db/src/repositories/campaigns.ts'),
      code: 'const rows = await db.insert(campaigns).values(row);',
    },
    {
      name: 'same path on Windows',
      filename: windows('packages/db/repositories/campaigns.ts'),
      code: 'await db.update(campaigns).set({ state });',
    },
    {
      name: 'a global repository is still a repository',
      filename: posix('packages/db/repositories/global/workspaces.ts'),
      code: 'await db.select().from(workspaces);',
    },
    {
      name: 'an unrelated method named select',
      filename: posix('packages/campaigns/src/launch.ts'),
      code: 'const chosen = picker.select(options);',
    },
    {
      name: 'a non-db object',
      filename: posix('apps/api/src/routes/campaigns.ts'),
      code: 'await queue.insert(job);',
    },
  ],

  invalid: [
    {
      name: 'db.select in a service',
      filename: posix('packages/campaigns/src/launch.ts'),
      code: 'const rows = await db.select().from(campaigns);',
      errors: [{ messageId: 'dbOutsideRepositories' }],
    },
    {
      name: 'db.insert in a controller',
      filename: posix('apps/api/src/controllers/campaigns.ts'),
      code: 'await db.insert(campaigns).values(row);',
      errors: [{ messageId: 'dbOutsideRepositories' }],
    },
    {
      name: 'db.delete in the edge app',
      filename: posix('apps/edge/src/ingest.ts'),
      code: 'await db.delete(events);',
      errors: [{ messageId: 'dbOutsideRepositories' }],
    },
    {
      name: 'db.execute for raw SQL',
      filename: posix('packages/analytics/src/rollup.ts'),
      code: 'await db.execute(sql`select 1`);',
      errors: [{ messageId: 'dbOutsideRepositories' }],
    },
    {
      name: 'this.db.update in a service class',
      filename: posix('packages/billing/src/entitlements.ts'),
      code: 'class S { async f() { await this.db.update(t).set({ a: 1 }); } }',
      errors: [{ messageId: 'dbOutsideRepositories' }],
    },
    {
      name: 'db/ but not db/repositories/',
      filename: posix('packages/db/src/client.ts'),
      code: 'await db.select().from(t);',
      errors: [{ messageId: 'dbOutsideRepositories' }],
    },
  ],
});
