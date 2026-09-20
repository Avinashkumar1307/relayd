/**
 * Section D fixtures: import jobs.
 *
 * DEMO ONLY. Every value is the one frames D6a–D6d print, so the preview and
 * the design can be put side by side: the four finished jobs of D6a's
 * history, the job importing right now in D6d (13,800 of 14,286 rows), and
 * one job still waiting to be mapped — `imp_draft`, which is what makes the
 * mapping and consent stages reachable from a link rather than only from a
 * file the browser has just read.
 *
 * The frozen clock is 19 Sep 2026 12:00 UTC, so the timestamps below are
 * written out rather than derived: the frames name exact minutes, and they
 * name them in the workspace's zone (Asia/Dubai, UTC+4), which is what the
 * history column formats in.
 */

/**
 * The nine columns of `eu-leisure-sept.csv`, as D6b lists them.
 *
 * BACKEND PENDING: GET /audience/imports/:id — the real API has no column
 * analysis yet, and the page falls back to reading the header row in the
 * browser when this is absent.
 */
export const draftColumns = [
  { name: 'email', samples: ['amira.khalil@example.ae', 'j.moreau@example.fr'] },
  { name: 'first_name', samples: ['Amira', 'Julien', 'Noor'] },
  { name: 'last_name', samples: ['Khalil', 'Moreau', 'Saleh'] },
  { name: 'country_code', samples: ['AE', 'FR', 'AE'] },
  { name: 'lang', samples: ['en', 'fr', 'ar'] },
  { name: 'signup_date', samples: ['2026-03-12', '2026-01-03'] },
  { name: 'tier', samples: ['Gold', 'Silver', 'Gold'] },
  { name: 'utm_source', samples: ['google', 'meta', 'direct'] },
  { name: 'internal_notes', samples: ['call back'] },
];

/**
 * The mapping the server detected for those columns.
 *
 * Seven of nine, which is where D6b's "7 of 9 columns mapped automatically"
 * comes from. `utm_source` is left undecided — the amber "Choose a field…"
 * row — and `internal_notes` is in `skippedColumns` instead, which is the
 * greyed row with an "Include" button.
 */
export const draftMapping = {
  email: 'email',
  first_name: 'firstName',
  last_name: 'lastName',
  country_code: 'country',
  lang: 'language',
  signup_date: 'created_at',
  tier: 'loyalty_tier',
};

/** The pre-flight estimate D6b's warning line and D6c's panel are drawn from. */
const draftEstimate = {
  byteSize: 13_002_342,
  encoding: 'UTF-8',
  rowCount: 14_286,
  invalidEmailCount: 412,
  existingEmailCount: 1_104,
  suppressedCount: 86,
  contactsAfter: 60_983,
  contactLimit: 100_000,
};

export const imports = [
  {
    id: 'imp_draft',
    originalFilename: 'eu-leisure-sept.csv',
    fileType: 'csv',
    status: 'mapping',
    columnMapping: draftMapping,
    columns: draftColumns,
    skippedColumns: ['internal_notes'],
    totalRows: null,
    processedRows: 0,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    createdAt: '2026-09-20T05:29:00.000Z',
    completedAt: null,
    ...draftEstimate,
  },
  {
    id: 'imp_3c8v2',
    originalFilename: 'eu-leisure-sept.csv',
    fileType: 'csv',
    status: 'processing',
    columnMapping: draftMapping,
    columns: draftColumns,
    totalRows: 14_286,
    processedRows: 13_800,
    createdCount: 12_336,
    updatedCount: 1_066,
    skippedCount: 0,
    failedCount: 398,
    createdAt: '2026-09-20T05:31:00.000Z',
    completedAt: null,
    attestedBy: 'Dana Haddad',
    consentSourceLabel: 'web form (double opt-in)',
    etaSeconds: 40,
    ...draftEstimate,
  },
  {
    id: 'imp_9r4t1',
    originalFilename: 'uae-offers-aug.xlsx',
    fileType: 'xlsx',
    status: 'completed',
    columnMapping: { email: 'email', name: 'firstName' },
    totalRows: 3_550,
    processedRows: 3_550,
    createdCount: 3_120,
    updatedCount: 412,
    skippedCount: 18,
    failedCount: 0,
    createdAt: '2026-09-15T04:30:00.000Z',
    completedAt: '2026-09-15T04:34:00.000Z',
    attestedBy: 'Farah Al-Mansoori',
  },
  {
    id: 'imp_7m2k8',
    originalFilename: 'crm-export-2026-09-01.csv',
    fileType: 'csv',
    status: 'completed',
    columnMapping: { email: 'email', first_name: 'firstName', last_name: 'lastName' },
    totalRows: 48_402,
    processedRows: 48_402,
    createdCount: 9_360,
    updatedCount: 1_104,
    skippedCount: 96,
    failedCount: 24,
    createdAt: '2026-09-01T10:02:00.000Z',
    completedAt: '2026-09-01T10:19:00.000Z',
    rowCount: 48_402,
    attestedBy: 'Dana Haddad',
    consentSourceLabel: 'CRM opt-in',
  },
  {
    id: 'imp_2b6x4',
    originalFilename: 'f1-waitlist.csv',
    fileType: 'csv',
    status: 'completed',
    columnMapping: { email: 'email', first_name: 'firstName' },
    totalRows: 9_700,
    processedRows: 9_700,
    createdCount: 9_562,
    updatedCount: 0,
    skippedCount: 60,
    failedCount: 78,
    createdAt: '2026-08-28T06:15:00.000Z',
    completedAt: '2026-08-28T06:21:00.000Z',
    rowCount: 9_700,
    attestedBy: 'Omar Haddad',
    consentSourceLabel: 'web form',
  },
  {
    id: 'imp_5t9w3',
    originalFilename: 'agency-list.csv',
    fileType: 'csv',
    status: 'failed',
    columnMapping: { email: 'email' },
    totalRows: 2_200,
    processedRows: 2_200,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 2_200,
    createdAt: '2026-08-03T05:48:00.000Z',
    completedAt: '2026-08-03T05:49:00.000Z',
    rowCount: 2_200,
    attestedBy: 'Julien Moreau',
  },
];

/**
 * The rejected rows behind `f1-waitlist.csv`, for the report and its
 * download. Deliberately includes a formula-shaped value: the download is
 * made of the values the importer refused, and it is opened in a
 * spreadsheet by definition.
 */
export const importErrors: Record<string, unknown[]> = {
  imp_2b6x4: [
    { rowNumber: 14, columnName: 'email', errorCode: 'invalid_email', message: 'This does not look like an email address', rawValue: 'amira.khalil@' },
    { rowNumber: 61, columnName: 'email', errorCode: 'invalid_email', message: 'This does not look like an email address', rawValue: 'noor.s@example' },
    { rowNumber: 128, columnName: 'email', errorCode: 'missing_email', message: 'The email column was empty', rawValue: '' },
    { rowNumber: 204, columnName: 'first_name', errorCode: 'invalid_email', message: 'This does not look like an email address', rawValue: '=HYPERLINK("http://example.invalid")' },
    { rowNumber: 377, columnName: 'email', errorCode: 'duplicate', message: 'The same address appears earlier in this file', rawValue: 'karim.n@example.ae' },
  ],
  imp_5t9w3: [
    { rowNumber: 2, columnName: 'email', errorCode: 'invalid_email', message: 'This does not look like an email address', rawValue: 'sales@' },
  ],
};
