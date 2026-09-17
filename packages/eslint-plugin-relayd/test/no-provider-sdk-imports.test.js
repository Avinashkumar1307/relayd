import rule from '../src/rules/no-provider-sdk-imports.js';
import { posix, ruleTester, windows } from './harness.js';

ruleTester.run('no-provider-sdk-imports', rule, {
  valid: [
    {
      name: 'SES SDK inside the SES adapter',
      filename: posix('packages/email-providers/adapters/ses/client.ts'),
      code: 'import { SESv2Client } from "@aws-sdk/client-sesv2";',
    },
    {
      name: 'nodemailer inside the SMTP adapter, src/ layout',
      filename: posix('packages/email-providers/src/adapters/smtp/index.ts'),
      code: 'import nodemailer from "nodemailer";',
    },
    {
      name: 'sendgrid scope inside an adapter',
      filename: posix('packages/email-providers/adapters/sendgrid/send.ts'),
      code: 'import sg from "@sendgrid/mail";',
    },
    {
      name: 'stripe inside the billing adapter',
      filename: posix('packages/billing/adapters/stripe/client.ts'),
      code: 'import Stripe from "stripe";',
    },
    {
      name: 'same path on Windows',
      filename: windows('packages/email-providers/adapters/ses/client.ts'),
      code: 'import { SESv2Client } from "@aws-sdk/client-sesv2";',
    },
    {
      name: 'importing the port, not an SDK',
      filename: posix('packages/campaigns/src/dispatch.ts'),
      code: 'import { sendWithLimits } from "@relayd/email-providers";',
    },
  ],

  invalid: [
    {
      name: 'SES SDK in a service',
      filename: posix('packages/campaigns/src/send.ts'),
      code: 'import { SESv2Client } from "@aws-sdk/client-sesv2";',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'nodemailer in the api app',
      filename: posix('apps/api/src/routes/test-send.ts'),
      code: 'import nodemailer from "nodemailer";',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'stripe in a controller',
      filename: posix('apps/api/src/controllers/billing.ts'),
      code: 'import Stripe from "stripe";',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'stripe inside an email adapter is still wrong',
      filename: posix('packages/email-providers/adapters/ses/client.ts'),
      code: 'import Stripe from "stripe";',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'SES SDK inside the billing adapter is still wrong',
      filename: posix('packages/billing/adapters/stripe/client.ts'),
      code: 'import { SESv2Client } from "@aws-sdk/client-sesv2";',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'dynamic import',
      filename: posix('apps/worker/src/entrypoints/send.ts'),
      code: 'const m = await import("mailgun.js");',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'require',
      filename: posix('packages/notifications/src/send.ts'),
      code: 'const nm = require("nodemailer");',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 're-export',
      filename: posix('packages/email-providers/src/index.ts'),
      code: 'export { default } from "@getbrevo/brevo";',
      errors: [{ messageId: 'confinedSdk' }],
    },
    {
      name: 'subpath import of a confined package',
      filename: posix('apps/api/src/x.ts'),
      code: 'import x from "stripe/lib/utils";',
      errors: [{ messageId: 'confinedSdk' }],
    },
  ],
});
