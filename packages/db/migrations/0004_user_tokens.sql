-- 0004_user_tokens.sql
--
-- Single-use tokens for email verification and password reset.
--
-- DOCS GAP. docs/02 section 3 defines token storage for workspace invitations
-- and for session refresh, and nowhere else — yet BUILD-PLAN Phase 1 requires
-- "verify email" and "password reset", and docs/03 lists /auth/verify-email,
-- /auth/forgot-password and /auth/reset-password. The flows are specified with
-- no table to hold their tokens. This is that table, shaped to match the
-- invitation pattern docs/02 already uses. Recorded in docs/16 section 27.
--
-- Cross-tenant, like users and sessions: a token belongs to a person, and
-- password reset runs before any workspace is in context. No RLS, for the same
-- reason those two have none (migration 0003).
--
-- Immutable once merged (CLAUDE.md section 8).

CREATE TABLE user_tokens (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose      text        NOT NULL
               CHECK (purpose IN ('email_verification','password_reset')),
  -- sha256 of the emailed token. The token itself is never stored, so a
  -- database dump cannot be replayed into an account takeover.
  token_hash   bytea       NOT NULL,
  expires_at   timestamptz NOT NULL,
  -- Set when redeemed. Single use: a reset link that still works after the
  -- password changed is a second chance for whoever intercepted the email.
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_user_tokens_hash ON user_tokens (token_hash);

-- Supports "invalidate every outstanding reset for this user", which is what
-- a successful reset or a password change must do.
CREATE INDEX ix_user_tokens_live ON user_tokens (user_id, purpose)
  WHERE consumed_at IS NULL;

-- ROLLBACK:
-- DROP TABLE IF EXISTS user_tokens;
