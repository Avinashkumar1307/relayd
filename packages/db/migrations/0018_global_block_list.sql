-- 0018_global_block_list.sql
--
-- The cross-workspace block list and the link-reputation cache
-- (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
--
-- docs/06: "Shared signals — Addresses that complained in any workspace go on
-- a global block list applied everywhere." And: "Tracked link domains checked
-- against a reputation feed; known-bad domains block the launch."
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS global_blocked_addresses;
--   DROP TABLE IF EXISTS blocked_link_domains;


-- ---------------------------------------------------------------------------
-- global_blocked_addresses
--
-- The only table in the system that is deliberately not tenant-scoped, and
-- the reason is the whole point of it: an address that complained in
-- workspace A must not be mailed by workspace B. A `workspace_id` column
-- would defeat the feature.
--
-- ## Why the address is stored as a hash
--
-- This is a list of people who complained, assembled across every customer we
-- have. In plaintext it is the single most sensitive table in the database
-- and a standing temptation: it would let any workspace with read access test
-- whether a given person is on it, which is a cross-tenant information leak
-- dressed as a safety feature.
--
-- Hashed, it answers the only question we need — "is this address blocked" —
-- and answers nothing else. The hash is of the normalised (lowercased,
-- trimmed) address, computed in the application so the plaintext never
-- reaches a query log.
--
-- The trade-off, stated plainly: an operator cannot read this table to find
-- out who is on it, and a person exercising a deletion right has to be found
-- by hashing their address rather than by searching. Both are acceptable;
-- holding every complainer's address in plaintext forever is not.

CREATE TABLE global_blocked_addresses (
  -- SHA-256 of the normalised address, with the pepper from Secrets Manager.
  -- The pepper is what stops a stolen copy of this table being brute-forced
  -- against a dictionary of email addresses, which is otherwise trivial:
  -- the space of real addresses is small enough to enumerate.
  address_hash bytea PRIMARY KEY,

  -- Why it is here. A complaint and a spam-trap hit are different signals
  -- and one of them may later warrant a different policy.
  reason text NOT NULL
         CHECK (reason IN ('complaint', 'spam_trap', 'manual', 'abuse_report')),

  -- How many distinct workspaces have seen this address complain. One is a
  -- recipient who changed their mind; five is an address being sold on a
  -- list, and the difference matters for deciding what to do about the
  -- workspaces that keep mailing it.
  workspace_count integer NOT NULL DEFAULT 1 CHECK (workspace_count >= 1),

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_gba_last_seen ON global_blocked_addresses (last_seen_at);

-- Deliberately no RLS.
--
-- RLS is keyed on `app.workspace_id` and this table has no workspace. Enabling
-- it with a `USING (true)` policy would be theatre, and enabling it without
-- one would make the table unreadable. Access is controlled by grant instead:
-- only `relayd_global` and the send path's scoped role may read it, and
-- nothing may read a row back out in a form that reveals an address.


-- ---------------------------------------------------------------------------
-- blocked_link_domains
--
-- Domains a reputation feed called malicious, cached so a launch does not
-- depend on a third party being up (see
-- `packages/campaigns/src/abuse/link-reputation.ts`, which fails open).
--
-- Also the place an operator adds a domain by hand, which is the faster path
-- when a campaign is going out right now and the feed has not caught up.

CREATE TABLE blocked_link_domains (
  domain text PRIMARY KEY,

  verdict text NOT NULL CHECK (verdict IN ('malicious', 'suspicious')),

  -- The feed that said so, or 'operator'. Kept because an appeal starts with
  -- "who says", and because a feed that turns out to be wrong repeatedly is
  -- one we should stop paying for.
  source text NOT NULL,

  note text,

  -- When the verdict should be re-checked. A domain does not stay malicious
  -- forever: they get cleaned up, resold, and reused, and a permanent block
  -- list slowly fills with entries nobody can justify.
  expires_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_bld_expires ON blocked_link_domains (expires_at)
  WHERE expires_at IS NOT NULL;
