import { iso } from './clock.js';

/**
 * Section F fixtures: the eight active templates and three archived ones the
 * F1 grid draws, and the seven versions behind "Autumn escapes".
 *
 * DEMO ONLY. Mirrored from `.design-rendered/frames/F/*.html` and from
 * `design/sample-data.js`: the campaign ids on the version cards
 * (`cmp_8f3k2a`, `cmp_2x8d4c`, `cmp_7q1m9z`, `cmp_3h7t6w`) are the workspace's
 * own, so following one from a version lands on the campaign it sent.
 *
 * The bodies keep their merge tags unrendered. Only `preview()` below
 * interpolates them, which is the same split the real API has: the editor
 * shows source, the preview endpoint shows the result.
 */

const NAVY = '#141B3D';
const INDIGO = '#4F46E5';
const SKY = '#0EA5E9';

export const AUTUMN_ID = 'tpl_autumn_26';

/**
 * F2a's source, line for line: the image on line 6 has no `alt` and the
 * unsubscribe link is in the footer, which is exactly what the lint strip
 * under the editor reports.
 */
const AUTUMN_HTML = `<!doctype html>
<html lang="en">
<body style="margin:0;background:#F7F8FC;font-family:Inter,Arial,sans-serif">
  <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0">
    <tr><td style="padding:20px 28px;background:#141B3D;color:#fff">
      <img src="{{asset:logo-light.png}}" width="120">
    </td></tr>
    <tr><td><img src="{{asset:hero-santorini.jpg}}" width="600" alt=""></td></tr>
    <tr><td style="padding:28px">
      <h1 style="font-size:22px;margin:0">Autumn escapes from {{home_airport|"DXB"}}</h1>
      <p>Hi {{first_name|"there"}}, your {{loyalty_tier|"Member"}} fares to Santorini open today. Two nights free on selected stays when you book before 30 September.</p>
      <a href="{{link:offers}}" style="background:#4F46E5;color:#fff;padding:11px 18px;border-radius:8px">See the offers</a>
    </td></tr>
    <tr><td style="padding:20px 28px;font-size:12px;color:#6B7280">
      Northwind Voyages LLC · Dubai, UAE · <a href="{{unsubscribe_url}}">Unsubscribe</a>
      · <a href="{{preferences_url}}">Preferences</a> · <a href="{{view_in_browser_url}}">View in browser</a>
    </td></tr>
  </table>
</body>
</html>`;

const AUTUMN_TEXT = `Autumn escapes from {{home_airport|"DXB"}}

Hi {{first_name|"there"}}, your {{loyalty_tier|"Member"}} fares to Santorini open
today. Two nights free on selected stays when you book before 30 September.

See the offers: {{link:offers}}

Northwind Voyages LLC · Dubai, UAE
Unsubscribe: {{unsubscribe_url}}`;

const AUTUMN_SUBJECT = 'Autumn escapes from {{home_airport|"DXB"}} — Santorini fares open';
const AUTUMN_PREHEADER =
  'Gold fares to Santorini, Mykonos and Crete open today. Two nights free on selected stays.';

const VARIABLES = [
  { field: 'first_name', default: 'there', required: false },
  { field: 'loyalty_tier', default: 'Member', required: false },
  { field: 'home_airport', default: 'DXB', required: false },
  { field: 'unsubscribe_url', default: '', required: true },
];

export const templates = [
  { id: AUTUMN_ID, name: 'Autumn escapes', category: 'campaign', currentVersionId: 'tplv_autumn_6', state: 'draft', versionCount: 7, editedLabel: 'Edited 2 min ago by Dana Haddad', archived: false, accent: NAVY, hero: true, defaultSenderId: 'snd1', language: 'en', createdAt: iso(120), updatedAt: iso(0) },
  { id: 'tpl_news_eu', name: 'Monthly newsletter · EU', category: 'campaign', currentVersionId: 'tplv_news_1', state: 'published', versionCount: 12, editedLabel: 'Edited 8 Sep by Julien Moreau', archived: false, accent: NAVY, hero: true, defaultSenderId: 'snd2', language: 'en', createdAt: iso(400), updatedAt: iso(11) },
  { id: 'tpl_flash_uae', name: 'Flash sale · UAE', category: 'campaign', currentVersionId: 'tplv_flash_1', state: 'published', versionCount: 5, editedLabel: 'Edited 16 Sep by Omar Haddad', archived: false, accent: INDIGO, hero: true, defaultSenderId: 'snd1', language: 'en', createdAt: iso(210), updatedAt: iso(3) },
  { id: 'tpl_loyalty', name: 'Loyalty tier update', category: 'transactional', currentVersionId: 'tplv_loyalty_1', state: 'published', versionCount: 3, editedLabel: 'Edited 5 Sep by Farah Al-Mansoori', archived: false, accent: NAVY, hero: false, defaultSenderId: 'snd1', language: 'en', createdAt: iso(300), updatedAt: iso(14) },
  { id: 'tpl_f1_weekend', name: 'F1 weekend early access', category: 'campaign', currentVersionId: 'tplv_f1_1', state: 'published', versionCount: 4, editedLabel: 'Edited 18 Sep by Omar Haddad', archived: false, accent: SKY, hero: true, defaultSenderId: 'snd1', language: 'en', createdAt: iso(90), updatedAt: iso(1) },
  { id: 'tpl_booking', name: 'Booking confirmation', category: 'transactional', currentVersionId: 'tplv_booking_1', state: 'published', versionCount: 9, editedLabel: 'Edited 20 Aug by Dana Haddad', archived: false, accent: NAVY, hero: false, defaultSenderId: 'snd2', language: 'en', createdAt: iso(520), updatedAt: iso(30) },
  { id: 'tpl_welcome', name: 'Welcome to Northwind Miles', category: 'transactional', currentVersionId: 'tplv_welcome_1', state: 'published', versionCount: 2, editedLabel: 'Edited 12 Mar by Dana Haddad', archived: false, accent: INDIGO, hero: true, defaultSenderId: 'snd1', language: 'en', createdAt: iso(600), updatedAt: iso(191) },
  { id: 'tpl_winback', name: 'Re-engagement · 60 days', category: null, currentVersionId: null, state: 'draft', versionCount: 1, editedLabel: 'Edited yesterday by Julien Moreau', archived: false, accent: NAVY, hero: true, defaultSenderId: 'snd2', language: 'en', createdAt: iso(2), updatedAt: iso(1) },

  { id: 'tpl_summer_sale', name: 'Summer sale wrap-up', category: 'campaign', currentVersionId: 'tplv_summer_1', state: 'published', versionCount: 6, editedLabel: 'Edited 2 Aug by Dana Haddad', archived: true, accent: INDIGO, hero: true, defaultSenderId: 'snd1', language: 'en', createdAt: iso(320), updatedAt: iso(48) },
  { id: 'tpl_eid_2025', name: 'Eid 2025 offers', category: 'campaign', currentVersionId: 'tplv_eid_1', state: 'published', versionCount: 4, editedLabel: 'Edited 14 Jun by Farah Al-Mansoori', archived: true, accent: NAVY, hero: true, defaultSenderId: 'snd1', language: 'ar', createdAt: iso(460), updatedAt: iso(97) },
  { id: 'tpl_old_welcome', name: 'Welcome (2025)', category: 'transactional', currentVersionId: 'tplv_oldwelcome_1', state: 'published', versionCount: 8, editedLabel: 'Edited 3 Jan by Dana Haddad', archived: true, accent: NAVY, hero: false, defaultSenderId: 'snd2', language: 'en', createdAt: iso(800), updatedAt: iso(259) },
];

export interface DemoVersion {
  id: string;
  templateId: string;
  version: number;
  subject: string;
  preheader: string | null;
  htmlSource: string;
  htmlCompiled: string;
  textBody: string;
  variables: { field: string; default: string; required: boolean }[];
  publishedAt: string | null;
  createdAt: string;
  savedLabel?: string;
  historyLabel?: string;
  publishedLabel?: string;
  campaigns?: { id: string; name: string; status: string }[];
}

function autumn(
  version: number,
  publishedAt: string | null,
  extra: Partial<DemoVersion> = {},
): DemoVersion {
  return {
    id: `tplv_autumn_${version}`,
    templateId: AUTUMN_ID,
    version,
    subject: AUTUMN_SUBJECT,
    preheader: AUTUMN_PREHEADER,
    htmlSource: AUTUMN_HTML,
    htmlCompiled: AUTUMN_HTML,
    textBody: AUTUMN_TEXT,
    variables: VARIABLES,
    publishedAt,
    createdAt: publishedAt ?? iso(0),
    ...extra,
  };
}

/** The version history panel on F2b, newest first. */
const AUTUMN_VERSIONS: DemoVersion[] = [
  autumn(7, null, {
    savedLabel: 'Saved 2 min ago',
    historyLabel: 'Editing · saved 2 min ago by Dana Haddad',
  }),
  autumn(6, iso(4), {
    publishedLabel: 'Published 15 Sep 2026, 14:20 by Farah Al-Mansoori',
    campaigns: [
      { id: 'cmp_8f3k2a', name: 'Autumn Escapes: Dubai → Santorini', status: 'sending' },
      { id: 'cmp_2x8d4c', name: 'Abu Dhabi F1 weekend — early access', status: 'scheduled' },
    ],
  }),
  autumn(5, iso(18), {
    publishedLabel: 'Published 1 Sep 2026, 09:05 by Dana Haddad',
    campaigns: [
      { id: 'cmp_7q1m9z', name: 'September newsletter — EU edition', status: 'completed' },
    ],
  }),
  autumn(4, iso(30), {
    publishedLabel: 'Published 20 Aug 2026, 16:40 by Dana Haddad',
    campaigns: [
      { id: 'cmp_3h7t6w', name: 'Summer sale wrap-up', status: 'held' },
      { id: 'cmp_5n2v7b', name: 'Summer sale reminder', status: 'completed' },
    ],
  }),
  autumn(3, iso(48), { publishedLabel: 'Published 2 Aug 2026 · superseded' }),
  autumn(2, iso(70), { publishedLabel: 'Published 11 Jul 2026 · superseded' }),
  autumn(1, iso(96), { publishedLabel: 'Published 15 Jun 2026 · superseded' }),
];

/** A plausible single version for every other template. */
function plain(template: (typeof templates)[number]): DemoVersion {
  const html = `<!doctype html>
<html lang="en">
<body style="margin:0;background:#F7F8FC;font-family:Inter,Arial,sans-serif">
  <table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0">
    <tr><td style="padding:20px 28px;background:${template.accent};color:#fff">
      Northwind Voyages
    </td></tr>
    <tr><td style="padding:28px">
      <h1 style="font-size:22px;margin:0">${template.name}</h1>
      <p>Hi {{first_name|"there"}}, here is what is new for {{loyalty_tier|"Member"}} travellers.</p>
      <a href="{{link:offers}}" style="background:#4F46E5;color:#fff;padding:11px 18px;border-radius:8px">Read more</a>
    </td></tr>
    <tr><td style="padding:20px 28px;font-size:12px;color:#6B7280">
      Northwind Voyages LLC · Dubai, UAE · <a href="{{unsubscribe_url}}">Unsubscribe</a>
      · <a href="{{preferences_url}}">Preferences</a>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    id: template.currentVersionId ?? `tplv_${template.id}_draft`,
    templateId: template.id,
    version: template.versionCount,
    subject: `${template.name} — Hi {{first_name|"there"}}`,
    preheader: 'A short line under the subject, shown in most inboxes.',
    htmlSource: html,
    htmlCompiled: html,
    textBody: `${template.name}\n\nHi {{first_name|"there"}}, here is what is new.\n\nUnsubscribe: {{unsubscribe_url}}`,
    variables: VARIABLES,
    publishedAt: template.state === 'published' ? template.updatedAt : null,
    createdAt: template.updatedAt,
    ...(template.state === 'published'
      ? { publishedLabel: template.editedLabel.replace('Edited', 'Published') }
      : {
          savedLabel: template.editedLabel.replace('Edited ', 'Saved '),
          historyLabel: template.editedLabel.replace('Edited', 'Editing · saved'),
        }),
  };
}

export const versions: DemoVersion[] = [
  ...AUTUMN_VERSIONS,
  ...templates.filter((entry) => entry.id !== AUTUMN_ID).map(plain),
];

/**
 * The newest version of the headline template.
 *
 * Kept as its own export because `demo/fixtures.ts` — the pre-split barrel —
 * re-exports it by name.
 */
export const templateVersion = AUTUMN_VERSIONS[0];

/* ---------------------------------------------------------- the preview -- */

const TAG = /\{\{\s*([A-Za-z0-9_:.-]+)\s*(?:\|\s*"([^"]*)"\s*)?\}\}/gu;

/**
 * What the server's renderer does, badly but visibly: substitute the
 * contact's attributes, fall back to the quoted default, and leave the
 * system tags as links.
 */
export function render(source: string, contact: Record<string, string>): string {
  return source.replace(TAG, (_match, field: string, fallback: string | undefined) => {
    if (field === 'unsubscribe_url') return 'https://relayd.example/u/demo';
    if (field === 'preferences_url') return 'https://relayd.example/p/demo';
    if (field === 'view_in_browser_url') return 'https://relayd.example/v/demo';
    if (field.startsWith('link:')) return 'https://northwind.example/offers';
    if (field.startsWith('asset:')) return '';
    return contact[field] ?? fallback ?? '';
  });
}

/**
 * The rendered email, as the preview pane shows it.
 *
 * A whole document, because it goes into a sandboxed iframe with an opaque
 * origin and cannot inherit a single style from the app.
 */
export function previewHtml(contact: Record<string, string>): string {
  const first = contact['first_name'] ?? 'there';
  const tier = contact['loyalty_tier'] ?? 'Member';
  const airport = contact['home_airport'] ?? 'DXB';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F7F8FC;font-family:Inter,Arial,Helvetica,sans-serif">
  <div style="width:600px;max-width:calc(100% - 32px);margin:16px auto;background:#fff;border:1px solid #E5E7EB;box-sizing:border-box">
    <div style="padding:20px 28px;background:#141B3D;color:#fff;font-weight:600;font-size:15px;display:flex;align-items:center;gap:10px"><span style="width:26px;height:26px;border-radius:7px;background:#4F46E5;display:inline-block"></span>Northwind Voyages</div>
    <div style="height:200px;background:repeating-linear-gradient(135deg,#E5E7EB 0,#E5E7EB 6px,#F3F4F6 6px,#F3F4F6 12px);border:1px dashed #D1D5DB;display:flex;align-items:center;justify-content:center;font-size:12px;color:#6B7280">Hero image · 600×240 · alt text missing</div>
    <div style="padding:28px 28px 8px;color:#111827">
      <div style="font-size:22px;line-height:1.2;font-weight:600;letter-spacing:-0.01em">Autumn escapes from ${airport}</div>
      <p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#374151">Hi ${first}, your ${tier} fares to Santorini open today. Two nights free on selected stays when you book before 30 September.</p>
      <a href="https://northwind.example/offers" style="display:inline-block;margin-top:18px;padding:11px 18px;border-radius:8px;background:#4F46E5;color:#fff;font-weight:500;font-size:14px;text-decoration:none">See the offers</a>
    </div>
    <div style="padding:20px 28px 24px;margin-top:20px;border-top:1px solid #E5E7EB;font-size:12px;line-height:1.6;color:#6B7280">Northwind Voyages LLC · Dubai, UAE · <a href="https://relayd.example/u/demo" style="color:#4F46E5">Unsubscribe</a> · <a href="https://relayd.example/p/demo" style="color:#4F46E5">Preferences</a> · <a href="https://relayd.example/v/demo" style="color:#4F46E5">View in browser</a></div>
  </div>
</body></html>`;
}
