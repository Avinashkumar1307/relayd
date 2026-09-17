import { BILLING_PLAN_DIRS, isUnder } from '../paths.js';

const PLAN_CODES = new Set(['free', 'starter', 'pro', 'business', 'enterprise']);
const COMPARISON_OPERATORS = new Set(['==', '!=', '===', '!==']);

/** @param {import('estree').Node | null | undefined} node */
function planCodeOf(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string' && PLAN_CODES.has(node.value)) {
    return node.value;
  }
  return undefined;
}

/**
 * Plan codes in comparisons outside packages/billing/plans.
 *
 * Scoped to comparisons deliberately (CLAUDE.md section 7 says "in
 * comparisons"): the word "pro" appears in prose, test fixtures and UI copy,
 * and a rule that fired on every occurrence would be disabled within a week.
 * A comparison against a plan code is the thing that encodes business logic
 * in the wrong place.
 */
/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow plan code string literals in comparisons outside packages/billing/plans (CLAUDE.md section 7).',
    },
    schema: [],
    messages: {
      planLiteral:
        'Plan code "{{code}}" compared outside packages/billing/plans/**. Plan behaviour belongs in a feature or entitlement lookup, not a string comparison.',
    },
  },

  create(context) {
    if (isUnder(context.filename, BILLING_PLAN_DIRS)) return {};

    /** @param {import('estree').Node} node */
    const check = (node) => {
      const code = planCodeOf(node);
      if (code !== undefined) {
        context.report({ node, messageId: 'planLiteral', data: { code } });
      }
    };

    return {
      BinaryExpression(node) {
        if (!COMPARISON_OPERATORS.has(node.operator)) return;
        check(node.left);
        check(node.right);
      },
      SwitchCase(node) {
        check(node.test);
      },
    };
  },
};
