import rule from '../src/rules/no-plan-literals.js';
import { posix, ruleTester, windows } from './harness.js';

ruleTester.run('no-plan-literals', rule, {
  valid: [
    {
      name: 'plan definitions may name plans',
      filename: posix('packages/billing/plans/index.ts'),
      code: 'const f = plan.code === "pro" ? proFeatures : baseFeatures;',
    },
    {
      name: 'plan definitions, src/ layout',
      filename: posix('packages/billing/src/plans/definitions.ts'),
      code: 'switch (code) { case "enterprise": x(); break; }',
    },
    {
      name: 'same path on Windows',
      filename: windows('packages/billing/plans/index.ts'),
      code: 'const ok = code === "starter";',
    },
    {
      name: 'a plan code that is not compared',
      filename: posix('apps/web/src/copy.ts'),
      code: 'const heading = "pro";',
    },
    {
      name: 'entitlement lookup rather than plan comparison',
      filename: posix('packages/campaigns/src/launch.ts'),
      code: 'if (entitlements.has("campaign:launch")) { launch(); }',
    },
    {
      name: 'a non-plan string comparison',
      filename: posix('apps/api/src/routes/x.ts'),
      code: 'if (state === "draft") { noop(); }',
    },
  ],

  invalid: [
    {
      name: 'plan comparison in a service',
      filename: posix('packages/campaigns/src/launch.ts'),
      code: 'if (workspace.plan === "pro") { allowUnlimited(); }',
      errors: [{ messageId: 'planLiteral', data: { code: 'pro' } }],
    },
    {
      name: 'plan comparison in a controller',
      filename: posix('apps/api/src/controllers/billing.ts'),
      code: 'if (plan !== "free") { charge(); }',
      errors: [{ messageId: 'planLiteral' }],
    },
    {
      name: 'switch on plan codes',
      filename: posix('apps/web/src/components/Limits.tsx'),
      code: 'switch (plan) { case "business": cap(100); break; default: cap(1); }',
      errors: [{ messageId: 'planLiteral' }],
    },
    {
      name: 'literal on the left-hand side',
      filename: posix('packages/billing/src/gate.ts'),
      code: 'if ("enterprise" === plan) { skipLimits(); }',
      errors: [{ messageId: 'planLiteral' }],
    },
    {
      name: 'loose equality counts',
      filename: posix('apps/api/src/x.ts'),
      code: 'if (plan == "starter") { y(); }',
      errors: [{ messageId: 'planLiteral' }],
    },
    {
      name: 'billing package outside plans/ is not exempt',
      filename: posix('packages/billing/src/entitlements.ts'),
      code: 'const unlimited = plan === "enterprise";',
      errors: [{ messageId: 'planLiteral' }],
    },
  ],
});
