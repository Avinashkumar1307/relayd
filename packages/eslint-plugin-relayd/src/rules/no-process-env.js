import { CONFIG_DIRS, isUnder } from '../paths.js';

/** @param {import('estree').MemberExpression} node */
function isEnvProperty(node) {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name === 'env';
  if (node.computed && node.property.type === 'Literal') return node.property.value === 'env';
  return false;
}

/** Matches `process` and `globalThis.process`. */
function isProcessObject(node) {
  if (node.type === 'Identifier') return node.name === 'process';
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier' &&
    node.property.name === 'process'
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow process.env outside packages/config, which parses and validates it once (CLAUDE.md section 7).',
    },
    schema: [],
    messages: {
      processEnv:
        'process.env is only readable in packages/config/**. Add the variable to a schema fragment there and take a parsed, typed value instead.',
    },
  },

  create(context) {
    if (isUnder(context.filename, CONFIG_DIRS)) return {};

    return {
      MemberExpression(node) {
        if (!isEnvProperty(node)) return;
        if (!isProcessObject(node.object)) return;
        context.report({ node, messageId: 'processEnv' });
      },
    };
  },
};
