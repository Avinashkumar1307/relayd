/**
 * Redaction is configured here, once, not remembered at each call site
 * (docs/13-repo-and-coding-standards.md, "Logging").
 *
 * These paths are the log-side half of INVARIANTS R22; the other half is the
 * adapter boundary, which reconstructs provider errors into typed
 * ProviderError values and discards the original (Phase 3), and the Sentry
 * beforeSend denylist (Phase 3/10). A credential must survive none of them.
 *
 * Pino redaction is path-based, so every shape a secret can arrive in needs
 * its own entry. Wildcards cover one level only: `*.password` matches
 * `user.password` but not `a.b.password`, hence the explicit nesting below.
 */
export const REDACTION_PATHS: readonly string[] = [
  // Request and response headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',

  // Credential-shaped field names, at the top level and one level down
  'password',
  '*.password',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'credentials',
  '*.credentials',
  'authorization',
  '*.authorization',

  // Connection strings carry user:password@host
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'REDIS_URL',
  'connectionString',
  '*.connectionString',

  // Provider and payment credentials
  'smtpPassword',
  '*.smtpPassword',
  'secretAccessKey',
  '*.secretAccessKey',
  'stripeKey',
  '*.stripeKey',
];

export const REDACTION_CENSOR = '[REDACTED]';
