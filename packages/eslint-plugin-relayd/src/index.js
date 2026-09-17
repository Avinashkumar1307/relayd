/**
 * eslint-plugin-relayd — the five rules that encode the architecture.
 *
 * From CLAUDE.md section 7: "These encode the architecture. Build them in
 * Phase 0 and make them errors, not warnings." docs/13 puts the reason
 * plainly: "A rule that is not machine-checked is a convention people forget
 * under deadline."
 *
 * Written in JavaScript, not TypeScript, on purpose: ESLint loads the plugin
 * at config time, so a TypeScript plugin would have to be built before
 * `pnpm lint` could run. Lint must work on a fresh clone with no build step.
 */
import noConsole from './rules/no-console.js';
import noDbOutsideRepositories from './rules/no-db-outside-repositories.js';
import noPlanLiterals from './rules/no-plan-literals.js';
import noProcessEnv from './rules/no-process-env.js';
import noProviderSdkImports from './rules/no-provider-sdk-imports.js';

export const rules = {
  'no-db-outside-repositories': noDbOutsideRepositories,
  'no-plan-literals': noPlanLiterals,
  'no-provider-sdk-imports': noProviderSdkImports,
  'no-process-env': noProcessEnv,
  'no-console': noConsole,
};

/** Every rule is an error. There is no warning tier for architecture. */
export const configs = {
  recommended: {
    rules: {
      'relayd/no-db-outside-repositories': 'error',
      'relayd/no-plan-literals': 'error',
      'relayd/no-provider-sdk-imports': 'error',
      'relayd/no-process-env': 'error',
      'relayd/no-console': 'error',
    },
  },
};

export default { rules, configs };
