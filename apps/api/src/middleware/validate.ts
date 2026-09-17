import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { ValidationError } from '@relayd/types';

/**
 * Parses the request body with a Zod schema, or throws the 400 envelope.
 *
 * Controllers "parse and validate with Zod and call one service" (CLAUDE.md
 * section 6.1). This is that parse step, factored out so no handler is
 * tempted to reach for req.body untyped.
 *
 * Zod issues become the `details` array docs/03 specifies, so a client is told
 * which field is wrong rather than just that something is.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        new ValidationError(
          'Request validation failed',
          result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
      return;
    }

    // Replaced with the parsed value: strict schemas strip nothing, but
    // coercions (lowercased email, trimmed name) must reach the service.
    req.body = result.data;
    next();
  };
}
