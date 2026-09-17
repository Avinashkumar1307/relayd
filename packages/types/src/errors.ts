/**
 * The error codes from docs/03-api.md, exactly. One code enum, one base
 * class, one Express middleware that maps them to the envelope
 * (CLAUDE.md section 6.5).
 */
export const ERROR_CODES = [
  // 400
  'validation_failed',
  'malformed_request',
  // 401
  'unauthenticated',
  'token_expired',
  'invalid_api_key',
  // 402
  'entitlement_denied',
  'limit_reached',
  'payment_required',
  // 403
  'insufficient_permission',
  // 404 — also returned for cross-tenant access attempts, never 403
  'not_found',
  // 409
  'conflict',
  'invalid_state_transition',
  'idempotency_key_reuse',
  // 422
  'unprocessable',
  'plan_downgrade_blocked',
  // 429
  'rate_limited',
  // 500
  'internal_error',
  // 502 / 503
  'provider_unavailable',
  'service_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * Services throw these. Routes never catch them: one error middleware maps
 * every AppError to the envelope, and anything that is not an AppError
 * becomes a 500 carrying only a requestId.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: readonly ErrorDetail[],
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: readonly ErrorDetail[]) {
    super('validation_failed', message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('not_found', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code: ErrorCode = 'conflict') {
    super(code, message, 409);
  }
}

/** 402. The body names the feature, the limit and current usage (docs/03). */
export class EntitlementError extends AppError {
  constructor(
    message: string,
    readonly feature: string,
    readonly limit: number,
    readonly current: number,
  ) {
    super('entitlement_denied', message, 402);
  }
}
