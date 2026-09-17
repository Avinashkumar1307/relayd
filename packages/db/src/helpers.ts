import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Pure helpers used by repositories.
 *
 * They live outside repositories/ deliberately. Everything exported from that
 * directory takes a WorkspaceScope as its first parameter, enforced by a CI
 * reflection test, and the rule is worth more absolute than with a list of
 * exceptions attached — a rule with exceptions is a rule people argue with.
 * Neither of these touches a tenant row, so neither belongs there.
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
