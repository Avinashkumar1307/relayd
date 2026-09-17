/**
 * Pulls the statements out of a migration's `-- ROLLBACK:` comment.
 *
 * CLAUDE.md section 8 requires every migration to carry one, and the runner
 * refuses a migration without it. This is what lets a test actually execute
 * the documented reversal rather than trusting that someone wrote a true one.
 *
 * The block is everything from `-- ROLLBACK:` to the end of the file, with
 * the comment markers stripped.
 */
export function extractRollback(sql: string): string {
  const marker = '-- ROLLBACK:';
  const index = sql.indexOf(marker);
  if (index === -1) {
    throw new Error('Migration has no -- ROLLBACK: comment');
  }

  return sql
    .slice(index + marker.length)
    .split('\n')
    .map((line) => line.replace(/^\s*--\s?/u, '').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}
