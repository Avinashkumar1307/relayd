/**
 * Dates, as the frames print them.
 *
 * Three rules, all visible in C1 and G4a:
 *
 *   axis captions are "21 Aug" — day then short month, no year, no comma;
 *   a campaign's send time is "8 Sep 2026, 10:00 GST" — in the campaign's
 *   own timezone, with the abbreviation, because "10:00" in the reader's
 *   zone is a different moment from the one the campaign was scheduled for;
 *   "Sept" is not a month. `en-GB` abbreviates September to four letters,
 *   so the month comes from the table below rather than from the locale.
 */

export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "2026-08-21" or an ISO instant → "21 Aug". UTC, as the buckets are. */
export function dayLabel(day: string): string {
  const date = parse(day);
  if (date === null) return day;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''}`;
}

/** An ISO instant → "8 Sep 2026, 10:00 GST" in `timeZone`. */
export function instantLabel(iso: string, timeZone: string | null): string {
  const date = parse(iso);
  if (date === null) return iso;

  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
    ...(timeZone === null ? {} : { timeZone }),
  };

  const parts = new Intl.DateTimeFormat('en-GB', options).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  const month = MONTHS[Number(get('month')) - 1] ?? '';
  const zone = get('timeZoneName');

  return `${Number(get('day'))} ${month} ${get('year')}, ${get('hour')}:${get('minute')}${zone === '' ? '' : ` ${zone}`}`;
}

/** An ISO instant → "20 Sep" in `timeZone`: "Analytics through 20 Sep". */
export function shortDateLabel(iso: string, timeZone: string | null): string {
  const date = parse(iso);
  if (date === null) return iso;

  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    ...(timeZone === null ? {} : { timeZone }),
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${Number(get('day'))} ${MONTHS[Number(get('month')) - 1] ?? ''}`;
}

/** "22:00" — G4a's axis caption in the middle of a day. */
export function timeLabel(iso: string, timeZone: string | null): string {
  const date = parse(iso);
  if (date === null) return iso;

  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === null ? {} : { timeZone }),
  }).format(date);
}

/**
 * "GST" — the zone a campaign's hours are counted in.
 *
 * G4a's chart says "First 48 hours · hourly · GST" because a click at 03:00
 * means something different depending on whose 03:00 it was, and the answer
 * is always the campaign's own timezone rather than the reader's.
 */
export function zoneLabel(timeZone: string | null, at = new Date()): string {
  if (timeZone === null) return '';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(at);

  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
}

/** "+0h", "+13h": G4a's hourly axis, relative to the first bucket. */
export function hourLabel(iso: string, from: string): string {
  const at = parse(iso);
  const start = parse(from);
  if (at === null || start === null) return iso;
  return `+${Math.round((at.getTime() - start.getTime()) / 3_600_000)}h`;
}

/**
 * "10:00 · 8 Sep", the caption under G4a's hourly plot.
 *
 * Built from the two formatters above rather than from one: `en-GB` resolves
 * a numeric day to the `dd/MM` pattern and hands back "08", and "08 Sep" is
 * not what any frame draws. Every day here goes through `Number` for that
 * reason.
 */
export function hourCaption(iso: string, timeZone: string | null): string {
  const date = parse(iso);
  if (date === null) return iso;

  return `${timeLabel(iso, timeZone)} · ${shortDateLabel(iso, timeZone)}`;
}

function parse(value: string): Date | null {
  // A bare "2026-08-21" is parsed as UTC midnight by design: the server
  // buckets in UTC days, and letting the browser read it as local time
  // shifts every label by a day west of Greenwich.
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}
