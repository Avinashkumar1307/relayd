import { APP_AND_PACKAGE_DIRS, isUnder } from '../paths.js';

/**
 * console.* in apps/** and packages/**.
 *
 * Structured logging only (CLAUDE.md section 6.6). A console call bypasses
 * the logger's central redaction, so it is also the shortest path to a
 * credential in CloudWatch — see INVARIANTS R22.
 *
 * Build scripts and repository tooling outside apps/ and packages/ are not
 * covered, which is why the scope is written into the rule rather than left
 * to config: a future config edit cannot silently widen it.
 */
/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow console.* in apps/** and packages/** (CLAUDE.md section 7).',
    },
    schema: [],
    messages: {
      noConsole:
        'console.{{method}}() bypasses structured logging and central redaction. Use the logger from @relayd/logger.',
    },
  },

  create(context) {
    if (!isUnder(context.filename, APP_AND_PACKAGE_DIRS)) return {};

    return {
      MemberExpression(node) {
        if (node.object.type !== 'Identifier' || node.object.name !== 'console') return;

        const method =
          !node.computed && node.property.type === 'Identifier'
            ? node.property.name
            : 'log';

        context.report({ node, messageId: 'noConsole', data: { method } });
      },
    };
  },
};
