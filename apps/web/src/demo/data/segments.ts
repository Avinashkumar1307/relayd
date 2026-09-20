/**
 * Section D fixtures: segments.
 *
 * DEMO ONLY. The five rows of frame D5a, with the definitions that produce
 * its rule chips word for word — "Country is any of DE, FR, BE, NL",
 * "Last engaged within 90 days", "Tag is not Business" — and the live
 * preview numbers of D5b.
 *
 * Tag and list leaves carry the tag's *name* as its id. The demo's audience
 * fixtures (`data/audience.ts`, another section's file) do not yet have the
 * Northwind Voyages tags the segment frames use, and the builder falls back
 * to the id when it cannot resolve one, so the chips read as the design
 * draws them either way. Noted for the orchestrator.
 */

const attr = (path: string, value: string, cmp = 'eq') => ({ op: 'attr', path, cmp, value });

const anyOf = (path: string, values: readonly string[]) => ({
  op: 'or',
  children: values.map((value) => attr(path, value)),
});

/**
 * The saved definition behind D5a's first row.
 *
 * Three conditions, which is what that row's chips list. D5b draws the same
 * segment with a second group added and an "Unsaved" badge beside its name —
 * an edit in progress, not what is stored.
 */
export const euLeisureEngaged = {
  op: 'and',
  children: [
    anyOf('country', ['DE', 'FR', 'BE', 'NL']),
    attr('last_engaged_at', '90', 'gt'),
    { op: 'not', child: { op: 'has_tag', tagId: 'Business' } },
  ],
};

export const segments = [
  {
    id: 'seg_eu_eng',
    name: 'EU leisure · engaged',
    definition: euLeisureEngaged,
    cachedCount: 18_420,
    cachedAt: '2026-09-18T07:12:00.000Z',
    createdAt: '2026-05-04T09:00:00.000Z',
    updatedAt: '2026-09-18T07:12:00.000Z',
    lastUsedLabel: 'Autumn Escapes · 19 Sep',
  },
  {
    id: 'seg_uae_lei',
    name: 'UAE leisure',
    definition: {
      op: 'and',
      children: [
        attr('country', 'AE'),
        { op: 'or', children: [{ op: 'has_tag', tagId: 'Dubai' }, { op: 'has_tag', tagId: 'Abu Dhabi' }] },
      ],
    },
    cachedCount: 14_120,
    cachedAt: '2026-09-16T06:40:00.000Z',
    createdAt: '2026-04-19T11:20:00.000Z',
    updatedAt: '2026-09-16T06:40:00.000Z',
    lastUsedLabel: 'Eid al-Etihad flash sale',
  },
  {
    id: 'seg_vip_re',
    name: 'VIP re-engagement',
    definition: {
      op: 'and',
      children: [{ op: 'has_tag', tagId: 'VIP' }, attr('last_engaged_at', '60', 'lt')],
    },
    cachedCount: 640,
    cachedAt: '2026-09-02T08:05:00.000Z',
    createdAt: '2026-07-22T15:45:00.000Z',
    updatedAt: '2026-09-02T08:05:00.000Z',
    lastUsedLabel: null,
  },
  {
    id: 'seg_loy_gold',
    name: 'Loyalty tiers · Gold+',
    definition: {
      op: 'and',
      children: [anyOf('loyalty_tier', ['Gold', 'Platinum']), { op: 'status', value: 'subscribed' }],
    },
    cachedCount: 2_204,
    cachedAt: '2026-09-05T10:30:00.000Z',
    createdAt: '2026-06-11T13:05:00.000Z',
    updatedAt: '2026-09-05T10:30:00.000Z',
    lastUsedLabel: 'Loyalty tier upgrade notice',
  },
  {
    id: 'seg_family',
    name: 'Family holidays',
    definition: {
      op: 'and',
      children: [{ op: 'has_tag', tagId: 'Family' }, anyOf('language', ['en', 'ar'])],
    },
    cachedCount: 5_010,
    cachedAt: '2026-09-08T09:15:00.000Z',
    createdAt: '2026-03-28T08:40:00.000Z',
    updatedAt: '2026-09-08T09:15:00.000Z',
    lastUsedLabel: 'September newsletter',
  },
];

/** The cap the API previews against, and the subscribed population. */
export const PREVIEW_CAP = 10_000;
export const SUBSCRIBED_TOTAL = 45_102;

/** D5b's sample panel: five contacts, with the meta the frame prints. */
export const previewSample = [
  { email: 'amira.khalil@example.ae', meta: 'AE · engaged 2d ago' },
  { email: 'j.moreau@example.fr', meta: 'FR · engaged 5h ago' },
  { email: 'noor.s@example.ae', meta: 'AE · engaged 1d ago' },
  { email: 'elise.d@example.be', meta: 'BE · engaged 9d ago' },
  { email: 'karim.n@example.ae', meta: 'AE · engaged 3d ago' },
];
