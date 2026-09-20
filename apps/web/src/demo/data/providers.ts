/**
 * Section E fixtures: provider connections, identities, senders, DNS.
 *
 * DEMO ONLY. Every value is read off `design/sample-data.js` and the E
 * frames, so the preview is the frame: three connections (`prv_ses_eu1`,
 * `prv_sg_mkt`, `prv_smtp_1`) and five senders whose ids are the ones
 * section H already builds its pools from (`snd_hello`, `snd_news`,
 * `snd_offers`, `snd_members`, `snd_deals`). Changing an id here breaks
 * H1b, so change both or neither.
 *
 * No secret appears here even in fiction — the real product stores a
 * Secrets Manager ARN and never the secret (CLAUDE.md section 11). The
 * only credential-shaped string below is the *public* half of a DKIM
 * record, which is published in DNS by definition.
 */

/** E1a draws three cards, in this order. */
export const connections = [
  {
    id: 'prv_ses_eu1',
    providerType: 'ses',
    name: 'eu-west-1 · production',
    status: 'active',
    hasWebhookSecret: true,
    lastVerifiedAt: '2026-03-12T08:20:00.000Z',
    lastError: null,
    quotaSnapshot: { max24Hour: 50_000, sentLast24Hours: 41_200, maxSendRate: 14 },
    capabilities: { supportsWebhooks: true, reportsQuota: true, maxBatchSize: 50 },
    createdAt: '2026-03-12T08:20:00.000Z',
    quotaNote: '82% used · resets 00:00 UTC · spills to tomorrow',
    webhook: {
      state: 'receiving',
      label: 'Receiving events',
      detail: 'Last event 2 min ago · SNS subscription confirmed',
    },
    last24h: { accepted: 38_420, note: '0.7% bounce · 0.02% complaint' },
  },
  {
    id: 'prv_sg_mkt',
    providerType: 'sendgrid',
    name: 'marketing',
    status: 'degraded',
    hasWebhookSecret: true,
    lastVerifiedAt: '2026-06-02T06:00:00.000Z',
    lastError: null,
    quotaSnapshot: { max24Hour: 100_000, sentLast24Hours: 12_930, maxSendRate: 50 },
    capabilities: { supportsWebhooks: true, reportsQuota: true, maxBatchSize: 1_000 },
    createdAt: '2026-06-02T06:00:00.000Z',
    quotaNote: '13% used · plan limit 100,000/day',
    webhook: {
      state: 'no_events',
      label: 'No events since 08:40',
      detail: 'No events since 08:40 · check Event Webhook in SendGrid',
    },
    last24h: { accepted: 12_930, note: '— unknown until events resume' },
  },
  {
    id: 'prv_smtp_1',
    providerType: 'smtp',
    name: 'mail.northwind.travel',
    status: 'active',
    hasWebhookSecret: false,
    lastVerifiedAt: '2026-08-20T11:05:00.000Z',
    lastError: null,
    quotaSnapshot: { max24Hour: 5_000, sentLast24Hours: 1_120, maxSendRate: 2 },
    capabilities: { supportsWebhooks: false, reportsQuota: false, maxBatchSize: 1 },
    createdAt: '2026-08-20T11:05:00.000Z',
    quotaNote: '22% of your configured cap',
    webhook: {
      state: 'best_effort',
      label: 'Best-effort · no webhooks',
      detail: 'No webhooks · bounce mailbox polled hourly',
    },
    last24h: { accepted: 1_120, note: '1,120 accepted · 41 delivery uncertain' },
  },
];

/**
 * The identities behind the senders.
 *
 * `northwind.travel` is verified on SES and on SendGrid separately, because
 * verification belongs to the provider account and not to the domain: the
 * same domain can be live on one connection and pending on another, which
 * is exactly what E2a's fourth row shows.
 */
export const identities = [
  {
    id: 'idn_ses_travel',
    providerId: 'prv_ses_eu1',
    kind: 'domain',
    value: 'northwind.travel',
    verificationStatus: 'verified',
    dkimStatus: 'pass',
    spfStatus: 'pass',
    dmarcStatus: 'pass',
    verifiedAt: '2026-03-12T09:00:00.000Z',
    note: null,
  },
  {
    id: 'idn_sg_travel',
    providerId: 'prv_sg_mkt',
    kind: 'domain',
    value: 'northwind.travel',
    verificationStatus: 'verified',
    dkimStatus: 'pass',
    spfStatus: 'pass',
    dmarcStatus: 'pass',
    verifiedAt: '2026-06-02T07:10:00.000Z',
    note: null,
  },
  {
    id: 'idn_smtp_travel',
    providerId: 'prv_smtp_1',
    kind: 'domain',
    value: 'northwind.travel',
    verificationStatus: 'pending',
    dkimStatus: null,
    spfStatus: 'pass',
    dmarcStatus: 'pass',
    verifiedAt: null,
    note: 'DKIM record missing',
  },
  {
    id: 'idn_sg_deals',
    providerId: 'prv_sg_mkt',
    kind: 'domain',
    value: 'northwind-deals.com',
    verificationStatus: 'failed',
    dkimStatus: 'fail',
    spfStatus: 'pass',
    dmarcStatus: 'fail',
    verifiedAt: null,
    note: 'DMARC p=reject · DKIM mismatch',
  },
];

/** The five rows of E2a, in the frame's order. */
export const senders = [
  {
    id: 'snd_hello',
    providerId: 'prv_ses_eu1',
    identityId: 'idn_ses_travel',
    fromEmail: 'hello@northwind.travel',
    fromName: 'Northwind Voyages',
    replyTo: 'support@northwind.travel',
    status: 'active',
    dailyLimit: null,
    hourlyLimit: null,
    healthScore: 98,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSendAt: '2026-09-20T05:10:00.000Z',
  },
  {
    id: 'snd_news',
    providerId: 'prv_ses_eu1',
    identityId: 'idn_ses_travel',
    fromEmail: 'news@northwind.travel',
    fromName: 'Northwind News',
    replyTo: null,
    status: 'active',
    dailyLimit: null,
    hourlyLimit: null,
    healthScore: 96,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSendAt: '2026-09-08T06:00:00.000Z',
  },
  {
    id: 'snd_offers',
    providerId: 'prv_sg_mkt',
    identityId: 'idn_sg_travel',
    fromEmail: 'offers@northwind.travel',
    fromName: 'Northwind Offers',
    replyTo: 'support@northwind.travel',
    status: 'active',
    dailyLimit: null,
    hourlyLimit: null,
    healthScore: 91,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSendAt: '2026-09-16T07:12:00.000Z',
  },
  {
    id: 'snd_members',
    providerId: 'prv_smtp_1',
    identityId: 'idn_smtp_travel',
    fromEmail: 'members@northwind.travel',
    fromName: 'Northwind Miles',
    replyTo: null,
    status: 'active',
    dailyLimit: null,
    hourlyLimit: null,
    healthScore: 74,
    consecutiveFailures: 0,
    cooldownUntil: null,
    lastSendAt: '2026-09-05T10:30:00.000Z',
  },
  {
    id: 'snd_deals',
    providerId: 'prv_sg_mkt',
    identityId: 'idn_sg_deals',
    fromEmail: 'deals@northwind-deals.com',
    fromName: 'Northwind Deals',
    replyTo: 'support@northwind.travel',
    status: 'failed',
    dailyLimit: null,
    hourlyLimit: null,
    healthScore: 12,
    consecutiveFailures: 6,
    cooldownUntil: null,
    lastSendAt: null,
  },
];

/**
 * The SPF / DKIM / DMARC lookup behind one sender (E2b).
 *
 * The DKIM value is truncated with an ellipsis exactly as the frame draws
 * it: a real public key is 400-odd characters and the box would be the
 * whole drawer.
 */
export const senderDns: Record<string, unknown> = {
  snd_members: {
    senderId: 'snd_members',
    problem: {
      title: 'DKIM record not found.',
      detail:
        'Add it at your DNS host, then check again. Propagation can take up to 48 hours; we re-check every 15 minutes.',
    },
    records: [
      {
        kind: 'SPF',
        purpose: 'authorises the server to send',
        status: 'verified',
        type: 'TXT',
        host: 'northwind.travel',
        value: 'v=spf1 include:amazonses.com include:sendgrid.net ip4:185.12.64.10 ~all',
        found: 'Record found and includes mail.northwind.travel',
      },
      {
        kind: 'DKIM',
        purpose: 'signs each message',
        status: 'pending',
        type: 'TXT',
        host: 'rl1._domainkey.northwind.travel',
        value:
          'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3f8…Q2wIDAQAB',
        found: 'Not found at rl1._domainkey.northwind.travel',
      },
      {
        kind: 'DMARC',
        purpose: 'tells inboxes what to do on failure',
        status: 'verified',
        type: 'TXT',
        host: '_dmarc.northwind.travel',
        value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@northwind.travel; pct=100',
        found: 'Record found · p=quarantine',
      },
    ],
    lastCheckedAt: '2026-09-20T05:40:00.000Z',
    nextCheckInMinutes: 11,
  },
};

/** Every other sender: the same three records, all passing. */
export function verifiedDns(senderId: string, domain: string): unknown {
  return {
    senderId,
    problem: null,
    records: [
      {
        kind: 'SPF',
        purpose: 'authorises the server to send',
        status: 'verified',
        type: 'TXT',
        host: domain,
        value: 'v=spf1 include:amazonses.com include:sendgrid.net ip4:185.12.64.10 ~all',
        found: `Record found and includes ${domain}`,
      },
      {
        kind: 'DKIM',
        purpose: 'signs each message',
        status: 'verified',
        type: 'TXT',
        host: `rl1._domainkey.${domain}`,
        value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx3f8…Q2wIDAQAB',
        found: `Record found at rl1._domainkey.${domain}`,
      },
      {
        kind: 'DMARC',
        purpose: 'tells inboxes what to do on failure',
        status: 'verified',
        type: 'TXT',
        host: `_dmarc.${domain}`,
        value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@northwind.travel; pct=100',
        found: 'Record found · p=quarantine',
      },
    ],
    lastCheckedAt: '2026-09-20T05:40:00.000Z',
    nextCheckInMinutes: 11,
  };
}
