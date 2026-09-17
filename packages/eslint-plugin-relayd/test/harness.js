import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';

// RuleTester looks for describe/it on itself before falling back to running
// cases inline; wiring vitest in means each case reports as its own test.
RuleTester.describe = describe;
RuleTester.it = it;

export const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
});

/** A POSIX path, as Linux CI sees it. */
export const posix = (p) => `/srv/relayd/${p}`;

/** The same path as Windows sees it, to prove separator handling. */
export const windows = (p) =>
  ['C:', 'dev', 'relayd', ...p.split('/')].join(String.fromCharCode(92));
