import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Pure helpers used by repositories.
 *
 * They live outside repositories/ deliberately. Everything exported from that
 * directory takes a WorkspaceScope as its first parameter, enforced by a CI
 * reflection test, and the rule is worth more absolute than with a list of
 * exceptions attached — a rule with exceptions is a rule people argue with.
 * None of these touches a tenant row, so none belongs there.
 */

/**
 * The stored hash for a suppressed address.
 *
 * Lowercased and trimmed first: citext handles comparison of the text column,
 * but a hash is bytes, and "A@x.com" and "a@x.com" must produce the same one
 * or the fast membership check on the send path disagrees with the slow one.
 */
export function suppressionHash(email: string): Buffer {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest();
}

/**
 * The predicate D1's search box applies, in one place.
 *
 * Shared by the contacts list and by the `matching` count in
 * `AudienceStatsRepository.contactStats`, so the footer's "1–8 of 48,213"
 * cannot be the answer to a different question than the eight rows above it.
 *
 * `%` and `_` in the user's text are escaped. Unescaped, a search for "a_b"
 * quietly matches "axb", and a search for "%" matches the entire audience —
 * a typo that turns into a full scan returning everything.
 *
 * ILIKE on all three columns rather than relying on `email` being citext, so
 * the two plain-text name columns behave the same way. There is no trigram
 * index behind this, so a search is a scan bounded by one workspace's own
 * contacts; that is inside the contact limits the plans impose, and it is
 * the first thing to index if a workspace ever outgrows them.
 */
export function contactSearchPredicate(search: string | null | undefined): SQL {
  if (search === null || search === undefined || search === '') return sql`TRUE`;

  const pattern = `%${search.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`;

  return sql`(
    email::text ILIKE ${pattern}
    OR coalesce(first_name, '') ILIKE ${pattern}
    OR coalesce(last_name, '') ILIKE ${pattern}
  )`;
}

/**
 * Rebinds a compiled `$1`-style statement as a Drizzle SQL object.
 *
 * sql.raw() on its own would execute the text and DISCARD the parameters —
 * the statement would either fail on an unbound placeholder or, worse, run
 * with values the caller never supplied. Literal spans stay raw (the segment
 * compiler wrote them); every placeholder becomes a real bound parameter, so
 * the guarantee the compiler makes survives all the way to the driver.
 */
export function bindPlaceholders(text: string, params: readonly unknown[]): SQL {
  const pieces: SQL[] = [];
  const placeholder = /\$(\d+)/gu;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = placeholder.exec(text)) !== null) {
    pieces.push(sql.raw(text.slice(lastIndex, match.index)));

    const index = Number(match[1]) - 1;
    if (index < 0 || index >= params.length) {
      throw new Error(
        `Compiled SQL references $${match[1]} but only ${params.length} parameters were supplied`,
      );
    }
    pieces.push(sql`${params[index]}`);

    lastIndex = placeholder.lastIndex;
  }

  pieces.push(sql.raw(text.slice(lastIndex)));
  return sql.join(pieces);
}

/**
 * Escapes one value for COPY's text format.
 *
 * Postgres reads backslash, tab, newline and carriage return as control
 * sequences in this format. A name containing a tab would otherwise shift
 * every subsequent column by one — silently, with no error, producing
 * contacts whose last name is their country.
 */
export function escapeCopyValue(value: string | null): string {
  if (value === null) return String.raw`\N`;
  return value
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('\t', String.raw`\t`)
    .replaceAll('\n', String.raw`\n`)
    .replaceAll('\r', String.raw`\r`);
}
