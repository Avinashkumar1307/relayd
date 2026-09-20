import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import relayd from 'eslint-plugin-relayd';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      // The Claude Design export. Reference, never code that ships: the
      // frames are read for layout, tokens and copy, and `support.js` is a
      // generated browser runtime. Linting it would only ever produce
      // findings nobody is allowed to act on (CLAUDE.md section 15).
      'design/**',
      // Derived, git-ignored working directories: the rendered design frames
      // (scripts/design/render-frames.py) and the multi-agent workflow
      // scripts, which run in the orchestrator's own sandbox, not in ours.
      '.design-rendered/**',
      '.workflows/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      relayd,
    },
    rules: {
      // The five architecture rules. Errors, never warnings
      // (CLAUDE.md section 7).
      'relayd/no-db-outside-repositories': 'error',
      'relayd/no-plan-literals': 'error',
      'relayd/no-provider-sdk-imports': 'error',
      'relayd/no-process-env': 'error',
      'relayd/no-console': 'error',

      // Errors are never swallowed to return a default (CLAUDE.md section
      // 6.5), and unused values are a smell the compiler already rejects.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // The plugin is plain JavaScript and is parsed as such.
    files: ['packages/eslint-plugin-relayd/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
);
