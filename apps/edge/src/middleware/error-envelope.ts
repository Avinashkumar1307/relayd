import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@relayd/types';
import { getTraceContext, type Logger } from '@relayd/logger';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: readonly { path: string; message: string }[];
    requestId: string;
    docsUrl: string;
  };
}

const DOCS_BASE = 'https://docs.relayd.io/errors';

/**
 * The one error middleware (CLAUDE.md section 6.5). Maps AppError to the
 * envelope in docs/03; anything else becomes a 500 that leaks nothing.
 *
 * An unexpected error is logged in full with its stack, and the client gets
 * only a code and the requestId. docs/03: "Never leaks detail; requestId is
 * the handle for support."
 */
export function errorEnvelope(logger: Logger) {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const requestId = getTraceContext()?.requestId ?? 'unknown';

    if (error instanceof AppError) {
      // Expected outcomes, not incidents. 5xx AppErrors still warrant error
      // level; the rest are the API doing its job.
      const level = error.status >= 500 ? 'error' : 'warn';
      logger[level]({ err: error, code: error.code, status: error.status }, 'request failed');

      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          docsUrl: `${DOCS_BASE}/${error.code}`,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      res.status(error.status).json(body);
      return;
    }

    logger.error({ err: error }, 'unhandled error');

    const body: ErrorBody = {
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
        requestId,
        docsUrl: `${DOCS_BASE}/internal_error`,
      },
    };
    res.status(500).json(body);
  };
}

/** Terminal 404 for unmatched routes, in the same envelope. */
export function notFoundHandler(_req: Request, res: Response): void {
  const requestId = getTraceContext()?.requestId ?? 'unknown';
  const body: ErrorBody = {
    error: {
      code: 'not_found',
      message: 'Not found',
      requestId,
      docsUrl: `${DOCS_BASE}/not_found`,
    },
  };
  res.status(404).json(body);
}
