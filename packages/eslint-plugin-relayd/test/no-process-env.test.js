import rule from '../src/rules/no-process-env.js';
import { posix, ruleTester, windows } from './harness.js';

ruleTester.run('no-process-env', rule, {
  valid: [
    {
      name: 'the sanctioned reader',
      filename: posix('packages/config/src/env.ts'),
      code: 'const raw = process.env;',
    },
    {
      name: 'anywhere in the config package',
      filename: posix('packages/config/src/schema.ts'),
      code: 'const url = process.env.DATABASE_URL;',
    },
    {
      name: 'same path on Windows',
      filename: windows('packages/config/src/env.ts'),
      code: 'const raw = process.env;',
    },
    {
      name: 'other process properties are not config',
      filename: posix('apps/worker/src/shutdown.ts'),
      code: 'process.on("SIGTERM", drain);',
    },
    {
      name: 'a parsed config value',
      filename: posix('apps/api/src/server.ts'),
      code: 'const port = config.PORT;',
    },
  ],

  invalid: [
    {
      name: 'process.env in an app',
      filename: posix('apps/api/src/server.ts'),
      code: 'const port = process.env.PORT;',
      errors: [{ messageId: 'processEnv' }],
    },
    {
      name: 'process.env in a package',
      filename: posix('packages/db/src/client.ts'),
      code: 'const url = process.env.DATABASE_URL;',
      errors: [{ messageId: 'processEnv' }],
    },
    {
      name: 'computed access',
      filename: posix('apps/edge/src/index.ts'),
      code: 'const v = process["env"].REDIS_URL;',
      errors: [{ messageId: 'processEnv' }],
    },
    {
      name: 'destructuring',
      filename: posix('packages/queue/src/connection.ts'),
      code: 'const { REDIS_URL } = process.env;',
      errors: [{ messageId: 'processEnv' }],
    },
    {
      name: 'globalThis.process.env',
      filename: posix('apps/scheduler/src/index.ts'),
      code: 'const v = globalThis.process.env.TZ;',
      errors: [{ messageId: 'processEnv' }],
    },
    {
      name: 'a config-shaped path elsewhere is not exempt',
      filename: posix('apps/api/src/config/local.ts'),
      code: 'const v = process.env.NODE_ENV;',
      errors: [{ messageId: 'processEnv' }],
    },
  ],
});
