import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client.js';

/**
 * TanStack Query is the only server-state mechanism in this app. No Redux,
 * no second cache, no hand-rolled fetch state (CLAUDE.md section 2).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retrying a 4xx just delays showing the user what is wrong. Server
        // and network failures are worth one retry.
        retry: (failureCount, error) => {
          const status = (error as { status?: number }).status;
          if (status !== undefined && status >= 400 && status < 500) return false;
          return failureCount < 1;
        },
        refetchOnWindowFocus: false,
      },
    },
  });
}

/* ------------------------------------------------------------------ */
/* K4d — the request id an error state has to show                     */
/* ------------------------------------------------------------------ */

/**
 * The trace id the server put in the error envelope, if this failure came
 * with one.
 *
 * K4d's whole point is that the id on screen joins what the user saw to a
 * server trace (CLAUDE.md section 2: "one trace id from request → recipient
 * → provider message id"). `ApiError` already carries it off the envelope;
 * this is the one accessor every page's error state uses, so no page has to
 * know the shape of a rejection to render one.
 *
 * Anything that is not an `ApiError` — a render that threw, a network drop
 * before a response existed — genuinely has no id, and `undefined` is the
 * honest answer. `ErrorState` then draws the card without the mono chip
 * rather than with an invented id support cannot look up.
 */
export function requestIdOf(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.requestId;

  // A structurally-compatible error can come from a boundary that re-threw
  // across a module instance; read the field rather than the class.
  const candidate = (error as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : undefined;
}

/** The HTTP status, when the failure was a response at all. */
export function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * The line under K4d's request-id chip: "20 Sep 2026, 09:58:12 · HTTP 502".
 *
 * The time is when the page rendered the failure, which is close enough to
 * when it happened to find the trace and is the only clock the browser has.
 */
export function errorMeta(error: unknown, at: Date = new Date()): string {
  // Written out rather than left to `toLocaleString`, which renders
  // September as "Sept" in en-GB and as "Sep" in en-US: the frame says
  // "Sep", and a date that changes shape with the browser's locale is not
  // the line the design drew.
  const stamp =
    `${at.getDate()} ${MONTH[at.getMonth()] ?? ''} ${at.getFullYear()}, ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;

  const status = statusOf(error);
  return status === undefined ? stamp : `${stamp} · HTTP ${status}`;
}
