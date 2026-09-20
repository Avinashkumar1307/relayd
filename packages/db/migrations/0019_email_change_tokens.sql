-- 0019_email_change_tokens.sql
--
-- Lets `user_tokens` carry an email change.
--
-- WHY A MIGRATION IS UNAVOIDABLE HERE. J5 offers "Change email", and docs/06
-- requires that a new address be proved before it takes effect — the address
-- is the recovery channel for the whole account, so writing it on request
-- turns a borrowed laptop into a permanent takeover. Proving it means holding
-- the proposed address somewhere between the request and the click on the
-- link, and there is nowhere: `users` has no pending-email column and no
-- jsonb, and `user_tokens` has no column for it and a CHECK constraint that
-- refuses any purpose but the two from 0004.
--
-- The alternative considered and rejected: carry the new address inside the
-- token itself, signed, and store only its hash under the existing
-- 'email_verification' purpose. That works cryptographically and is wrong
-- operationally — /auth/verify-email would then accept an email-change token
-- and mark the OLD address verified, and no operator reading the table could
-- tell the two flows apart.
--
-- Expand-only: one nullable column and a widened CHECK. Nothing is rewritten,
-- no existing row changes, and every statement is safe to run while the API
-- is serving. `user_tokens` has no RLS and no workspace_id, deliberately and
-- for the reasons 0004 records: a token belongs to a person, not a workspace.
--
-- Immutable once merged (CLAUDE.md section 8).

-- The proposed address, held until the link in it is clicked. citext to match
-- users.email, so a change to "Dana@Example.com" collides with an existing
-- "dana@example.com" the same way a registration would.
ALTER TABLE user_tokens ADD COLUMN new_email citext;

-- Postgres named the 0004 column CHECK `user_tokens_purpose_check`. Dropped
-- and recreated rather than added alongside: two CHECKs on one column both
-- have to pass, so leaving the old one would make 'email_change' unwritable
-- while looking allowed.
ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_purpose_check;
ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_purpose_check
  CHECK (purpose IN ('email_verification','password_reset','email_change'));

-- new_email belongs to exactly one purpose, enforced in both directions: an
-- email_change row with no address is a token that cannot be redeemed, and a
-- password_reset row carrying an address is a bug on the way to writing it.
ALTER TABLE user_tokens ADD CONSTRAINT ck_user_tokens_new_email
  CHECK ((purpose = 'email_change') = (new_email IS NOT NULL));

-- ROLLBACK:
-- ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS ck_user_tokens_new_email;
-- DELETE FROM user_tokens WHERE purpose = 'email_change';
-- ALTER TABLE user_tokens DROP CONSTRAINT IF EXISTS user_tokens_purpose_check;
-- ALTER TABLE user_tokens ADD CONSTRAINT user_tokens_purpose_check
--   CHECK (purpose IN ('email_verification','password_reset'));
-- ALTER TABLE user_tokens DROP COLUMN new_email;
-- The DELETE is not optional: outstanding email_change rows would fail the
-- narrowed CHECK and the constraint would refuse to be added.
