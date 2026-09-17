import { BILLING_ADAPTER_DIRS, EMAIL_ADAPTER_DIRS, isUnder } from '../paths.js';

/**
 * Each SDK is confined to the adapter directory that owns it — not to a
 * single shared allowlist. Importing `stripe` inside an email adapter is as
 * much a layering break as importing it in a controller, and a shared list
 * would permit it.
 */
const CONFINED_SDKS = [
  { name: '@aws-sdk/client-sesv2', exact: true, dirs: EMAIL_ADAPTER_DIRS, where: 'packages/email-providers/adapters/**' },
  { name: 'nodemailer', exact: true, dirs: EMAIL_ADAPTER_DIRS, where: 'packages/email-providers/adapters/**' },
  { name: '@sendgrid/', exact: false, dirs: EMAIL_ADAPTER_DIRS, where: 'packages/email-providers/adapters/**' },
  { name: 'mailgun.js', exact: true, dirs: EMAIL_ADAPTER_DIRS, where: 'packages/email-providers/adapters/**' },
  { name: '@getbrevo/', exact: false, dirs: EMAIL_ADAPTER_DIRS, where: 'packages/email-providers/adapters/**' },
  { name: 'stripe', exact: true, dirs: BILLING_ADAPTER_DIRS, where: 'packages/billing/adapters/**' },
];

/** @param {string} source */
function confinementFor(source) {
  return CONFINED_SDKS.find((sdk) =>
    sdk.exact ? source === sdk.name || source.startsWith(`${sdk.name}/`) : source.startsWith(sdk.name),
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Confine provider and payment SDK imports to their adapter directories (CLAUDE.md section 7, docs/13).',
    },
    schema: [],
    messages: {
      confinedSdk:
        'Provider SDK "{{source}}" may only be imported from {{where}}. Depend on the ProviderPort interface instead, so the rate limiter and daily-quota check cannot be bypassed.',
    },
  },

  create(context) {
    const filename = context.filename;

    /**
     * @param {import('estree').Node} node
     * @param {unknown} rawSource
     */
    const check = (node, rawSource) => {
      if (typeof rawSource !== 'string') return;
      const sdk = confinementFor(rawSource);
      if (sdk === undefined) return;
      if (isUnder(filename, sdk.dirs)) return;

      context.report({
        node,
        messageId: 'confinedSdk',
        data: { source: rawSource, where: sdk.where },
      });
    };

    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const [first] = node.arguments;
        if (first?.type === 'Literal') check(node, first.value);
      },
    };
  },
};
