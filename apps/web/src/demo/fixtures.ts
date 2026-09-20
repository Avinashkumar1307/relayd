/**
 * Dummy data for the UI preview — the barrel.
 *
 * DEMO ONLY. Nothing here is imported by the real application — the demo
 * module is only loaded when `VITE_DEMO=1`.
 *
 * The fixtures themselves live one file per section under `data/`, so ten
 * teams can add rows without ever meeting in a diff. This file only
 * re-exports them, which keeps `import * as fixtures from './fixtures.js'`
 * working for everything written before the split.
 *
 * The numbers are chosen to make the screens legible rather than to be
 * realistic: a campaign mid-send, one that finished, one paused by the
 * enforcement ladder, a draft. Rates sit where the UI's thresholds change
 * colour so the states are visible without waiting for anything.
 */

export { iso } from './data/clock.js';
export { WORKSPACE_ID, session } from './data/auth.js';
export { team, workspace } from './data/workspace.js';
export { contacts, lists, tags, suppressions } from './data/audience.js';
export { imports } from './data/imports.js';
export { templates, templateVersion } from './data/templates.js';
export { campaigns, progress, recipients } from './data/campaigns.js';
export { overview, campaignAnalytics, links, devices } from './data/analytics.js';
export { connections, identities, senders } from './data/providers.js';
export { plans, billingOverview, invoices } from './data/billing.js';
export { apiKeys, scopes, webhookEndpoints, webhookDeliveries } from './data/platform.js';
