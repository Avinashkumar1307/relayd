import { DB_REPOSITORY_DIRS, isUnder } from '../paths.js';

const DB_METHODS = new Set(['select', 'insert', 'update', 'delete', 'execute']);

/**
 * True for `db` and for any member expression ending in `.db`, which covers
 * the `this.db.select(...)` form repositories use.
 * @param {import('estree').Node} node
 */
function isDatabaseObject(node) {
  if (node.type === 'Identifier') return node.name === 'db';
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name === 'db';
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Drizzle query calls outside packages/db/repositories. Repositories are the only code that touches the database (CLAUDE.md section 6.1).',
    },
    schema: [],
    messages: {
      dbOutsideRepositories:
        'db.{{method}}() is only allowed in packages/db/repositories/**. Move this query into a repository method that takes a WorkspaceScope as its first parameter.',
    },
  },

  create(context) {
    if (isUnder(context.filename, DB_REPOSITORY_DIRS)) return {};

    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier') return;
        if (!DB_METHODS.has(node.property.name)) return;
        if (!isDatabaseObject(node.object)) return;

        context.report({
          node,
          messageId: 'dbOutsideRepositories',
          data: { method: node.property.name },
        });
      },
    };
  },
};
