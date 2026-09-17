import { createHash } from 'node:crypto';
import {
  GetAccountCommand,
  ListEmailIdentitiesCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { providerError, secretsOf } from '../../errors.js';
import { classifySesError } from './errors.js';
import { parseSnsNotification, verifySnsSignature } from './sns.js';
import type {
  EmailProviderAdapter,
  NormalisedEmailEvent,
  OutboundMessage,
  ProviderCapabilities,
  ProviderCredentials,
  QuotaSnapshot,
  SendOutcome,
  SenderIdentitySnapshot,
  VerificationResult,
} from '../../port.js';

/**
 * Amazon SES (v2).
 *
 * Three things about SES shape this adapter:
 *
 *   New accounts are in the sandbox, where every *recipient* must also be a
 *   verified identity. `verifyConnection` reports it, because a customer who
 *   connects SES and sees nothing delivered has no other way to find out.
 *
 *   The account-level sending quota is the real ceiling, not the per-sender
 *   limit an operator sets. `getQuota` reads it so the router can respect it.
 *
 *   Delivery events arrive by SNS, not by a direct webhook, and an SNS
 *   subscription has to be confirmed before anything is delivered. The
 *   webhook half of this adapter handles both the confirmation and the
 *   notification envelope.
 *
 * The client is constructed per call from the credentials passed in, and a
 * small cache keyed by the credential material avoids rebuilding it on every
 * message. Adapters hold no credentials of their own (docs/07): a rotation
 * takes effect on the next send.
 */

const CAPABILITIES: ProviderCapabilities = {
  // SendBulkEmail takes up to 50 destinations. This adapter uses SendEmail
  // per recipient — see sendBatch.
  maxBatchSize: 50,
  supportsWebhooks: true,
  supportsTracking: true,
  supportsCustomHeaders: true,
  supportsScheduling: false,
  supportsSuppressionSync: true,
  returnsMessageId: true,
  reportsQuota: true,
  maxRecipientsPerMessage: 1,
  // SES rejects anything above 40 MB, before base64 expansion.
  maxMessageBytes: 40 * 1024 * 1024,
};

/** Lets tests supply a client without reaching AWS. */
export interface SesClientFactory {
  (credentials: Extract<ProviderCredentials, { type: 'ses' }>): Pick<SESv2Client, 'send'>;
}

const clientCache = new Map<string, Pick<SESv2Client, 'send'>>();

function defaultClientFactory(
  credentials: Extract<ProviderCredentials, { type: 'ses' }>,
): Pick<SESv2Client, 'send'> {
  // Keyed by a hash, never by the material itself: this key ends up in heap
  // dumps and in any debugger someone attaches.
  const key = createHash('sha256')
    .update(JSON.stringify([credentials.region, credentials.accessKeyId, credentials.secretAccessKey]))
    .digest('hex');

  const existing = clientCache.get(key);
  if (existing !== undefined) return existing;

  const client = new SESv2Client({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
    // The wrapper owns retries and timeouts. Letting the SDK retry as well
    // multiplies attempts and hides a rate limit behind its own backoff.
    maxAttempts: 1,
  });

  clientCache.set(key, client);
  return client;
}

function requireSesCredentials(
  credentials: ProviderCredentials,
): Extract<ProviderCredentials, { type: 'ses' }> {
  if (credentials.type !== 'ses') {
    throw providerError('auth_failed', 'These are not SES credentials');
  }
  return credentials;
}

export function createSesAdapter(
  clientFactory: SesClientFactory = defaultClientFactory,
): EmailProviderAdapter {
  const clientFor = (credentials: ProviderCredentials): Pick<SESv2Client, 'send'> =>
    clientFactory(requireSesCredentials(credentials));

  const sendOne = async (
    credentials: ProviderCredentials,
    message: OutboundMessage,
  ): Promise<SendOutcome> => {
    try {
      const client = clientFor(credentials);
      const response = await client.send(buildSendCommand(message) as never);

      const messageId = (response as { MessageId?: string }).MessageId ?? null;
      return {
        ok: true,
        recipientId: message.recipientId,
        providerMessageId: messageId,
        acceptedAt: new Date(),
      };
    } catch (cause) {
      return {
        ok: false,
        recipientId: message.recipientId,
        error: classifySesError(cause, secretsOf(credentials)),
      };
    }
  };

  return {
    type: 'ses',
    capabilities: CAPABILITIES,

    async verifyConnection(credentials): Promise<VerificationResult> {
      try {
        const client = clientFor(credentials);
        const account = (await client.send(new GetAccountCommand({}) as never)) as {
          ProductionAccessEnabled?: boolean;
          SendingEnabled?: boolean;
          SendQuota?: { Max24HourSend?: number; SentLast24Hours?: number; MaxSendRate?: number };
          EnforcementStatus?: string;
        };

        const sandbox = account.ProductionAccessEnabled !== true;

        return {
          ok: true,
          details: {
            // Surfaced because a sandbox account delivers only to verified
            // addresses, and a customer who does not know that sees a
            // campaign that reports success and arrives nowhere.
            sandbox,
            sendingEnabled: account.SendingEnabled ?? false,
            max24HourSend: account.SendQuota?.Max24HourSend ?? 0,
            maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
            enforcementStatus: account.EnforcementStatus ?? 'HEALTHY',
          },
        };
      } catch (cause) {
        return { ok: false, error: classifySesError(cause, secretsOf(credentials)) };
      }
    },

    async getQuota(credentials): Promise<QuotaSnapshot | null> {
      try {
        const client = clientFor(credentials);
        const account = (await client.send(new GetAccountCommand({}) as never)) as {
          SendQuota?: { Max24HourSend?: number; SentLast24Hours?: number; MaxSendRate?: number };
        };

        return {
          max24Hour: account.SendQuota?.Max24HourSend ?? null,
          sentLast24Hours: account.SendQuota?.SentLast24Hours ?? null,
          maxSendRate: account.SendQuota?.MaxSendRate ?? null,
          checkedAt: new Date(),
        };
      } catch {
        // A quota read is advisory. Failing it must not fail a send path that
        // only wanted to know whether there was headroom.
        return null;
      }
    },

    async listVerifiedIdentities(credentials): Promise<SenderIdentitySnapshot[]> {
      try {
        const client = clientFor(credentials);
        const listed = (await client.send(
          new ListEmailIdentitiesCommand({ PageSize: 100 }) as never,
        )) as {
          EmailIdentities?: { IdentityName?: string; IdentityType?: string; SendingEnabled?: boolean }[];
        };

        const identities: SenderIdentitySnapshot[] = [];

        for (const entry of listed.EmailIdentities ?? []) {
          if (entry.IdentityName === undefined) continue;

          const kind = entry.IdentityType === 'EMAIL_ADDRESS' ? 'email' : 'domain';
          let dkim: string | undefined;

          try {
            const detail = (await client.send(
              new GetEmailIdentityCommand({ EmailIdentity: entry.IdentityName }) as never,
            )) as { DkimAttributes?: { Status?: string } };
            dkim = detail.DkimAttributes?.Status;
          } catch {
            // One identity failing to describe must not lose the others.
            dkim = undefined;
          }

          identities.push({
            kind,
            value: entry.IdentityName,
            status: entry.SendingEnabled === true ? 'verified' : 'pending',
            ...(dkim === undefined ? {} : { dkim }),
          });
        }

        return identities;
      } catch {
        return [];
      }
    },

    send: sendOne,

    /**
     * SES has SendBulkEmail, and this does not use it.
     *
     * Bulk requires a stored template and per-destination replacement data.
     * Our messages are rendered per recipient — each has its own unsubscribe
     * token and tracking links — so there is no shared template to store, and
     * bulk would mean uploading one per campaign and keeping it in step.
     *
     * The concurrency here is what actually recovers the throughput: SES's
     * limit is a send *rate*, and the wrapper above already batches to 50.
     */
    async sendBatch(credentials, messages): Promise<SendOutcome[]> {
      if (messages.length === 0) return [];
      return Promise.all(messages.map((message) => sendOne(credentials, message)));
    },

    /**
     * Verifies the SNS signature.
     *
     * `secret` is the PEM certificate for this connection, fetched and cached
     * by the ingest layer. The port's method is synchronous and fetching a
     * certificate is not, so the fetch cannot happen here — and it should not:
     * the certificate URL comes out of an unauthenticated payload, so
     * retrieving it belongs with the rest of the SSRF checking, next to
     * isAmazonCertificateUrl.
     */
    verifyWebhookSignature(raw, _headers, secret): boolean {
      return verifySnsSignature(raw, secret);
    },

    parseWebhook(raw): NormalisedEmailEvent[] {
      return parseSnsNotification(raw);
    },
  };
}

function buildSendCommand(message: OutboundMessage): SendEmailCommand {
  const headers: Record<string, string> = {
    ...message.headers,
    'List-Unsubscribe': message.listUnsubscribe.mailto
      ? `<${message.listUnsubscribe.mailto}>, <${message.listUnsubscribe.url}>`
      : `<${message.listUnsubscribe.url}>`,
  };

  if (message.listUnsubscribe.oneClick) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return new SendEmailCommand({
    FromEmailAddress: `${message.from.name} <${message.from.email}>`,
    Destination: { ToAddresses: [message.to.email] },
    ...(message.replyTo === undefined ? {} : { ReplyToAddresses: [message.replyTo] }),
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: message.html, Charset: 'UTF-8' },
          Text: { Data: message.text, Charset: 'UTF-8' },
        },
        Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
      },
    },
  });
}

export { parseSnsNotification } from './sns.js';
