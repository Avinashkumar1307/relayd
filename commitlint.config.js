/**
 * Conventional Commits, enforced (docs/13 § Git).
 *
 * The type list is the one already in use across Phase 0, so history stays
 * consistent rather than splitting into before-and-after styles.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'test',
        'refactor',
        'perf',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    // Commit bodies here carry reasoning, SQL fragments and occasional long
    // identifiers. Wrapping is a matter of care, not a thing to fail a commit
    // over, so the body length rule is relaxed. The subject is still capped.
    'body-max-line-length': [0, 'always'],
    'footer-max-line-length': [0, 'always'],
    'header-max-length': [2, 'always', 100],
    // config-conventional bans sentence-case subjects. Here that would mean
    // writing "pino with central redaction" and "drizzle client" — misspelling
    // the things being described. Proper nouns start subjects in this codebase
    // constantly: Zod, Pino, Drizzle, Express, Vite, Testcontainers.
    //
    // The useful half of the rule is kept: Title Case and SHOUTING are still
    // rejected. Only sentence-case is allowed back in.
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
  },
};
