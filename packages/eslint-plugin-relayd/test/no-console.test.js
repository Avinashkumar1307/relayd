import rule from '../src/rules/no-console.js';
import { posix, ruleTester, windows } from './harness.js';

ruleTester.run('no-console', rule, {
  valid: [
    {
      name: 'repository tooling outside apps/ and packages/',
      filename: posix('scripts/check-migrations.js'),
      code: 'console.log("ok");',
    },
    {
      name: 'the structured logger',
      filename: posix('apps/api/src/server.ts'),
      code: 'logger.info({ port }, "listening");',
    },
    {
      name: 'an object that merely has a log method',
      filename: posix('packages/campaigns/src/x.ts'),
      code: 'audit.log({ event });',
    },
  ],

  invalid: [
    {
      name: 'console.log in an app',
      filename: posix('apps/api/src/server.ts'),
      code: 'console.log("listening");',
      errors: [{ messageId: 'noConsole', data: { method: 'log' } }],
    },
    {
      name: 'console.error in a package',
      filename: posix('packages/db/src/client.ts'),
      code: 'console.error(err);',
      errors: [{ messageId: 'noConsole' }],
    },
    {
      name: 'console.warn in the edge app',
      filename: posix('apps/edge/src/ingest.ts'),
      code: 'console.warn("unmatched event");',
      errors: [{ messageId: 'noConsole' }],
    },
    {
      name: 'console.debug in the worker',
      filename: posix('apps/worker/src/entrypoints/send.ts'),
      code: 'console.debug(payload);',
      errors: [{ messageId: 'noConsole' }],
    },
    {
      name: 'same path on Windows',
      filename: windows('apps/api/src/server.ts'),
      code: 'console.log("x");',
      errors: [{ messageId: 'noConsole' }],
    },
    {
      name: 'console in a test inside a package is still console',
      filename: posix('packages/campaigns/test/launch.test.ts'),
      code: 'console.log(result);',
      errors: [{ messageId: 'noConsole' }],
    },
  ],
});
