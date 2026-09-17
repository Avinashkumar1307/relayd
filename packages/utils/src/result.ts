/**
 * Result type for domain boundaries where failure is an expected outcome
 * rather than an exception (docs/13, "Error handling").
 *
 * Services throw AppError for anything the HTTP layer should map. This is for
 * the narrower case where a caller must branch on the failure — a login that
 * did not match, a guarded transition that lost its race — and an exception
 * would be control flow.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** Unwraps, or throws. Use only where the error case is genuinely impossible. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`unwrap called on an error result: ${String(result.error)}`);
}
