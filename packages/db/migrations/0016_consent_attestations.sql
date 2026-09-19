-- 0016_consent_attestations.sql
--
-- Consent attestation (docs/06 "Anti-abuse"; BUILD-PLAN Phase 11).
--
-- docs/06: "Every import records a declared consent source; every launch
-- re-confirms it. Stored, timestamped, attributed to a user."
--
-- docs/02 already requires `import_jobs.options.consentDeclaration`, and that
-- stays — it is what gets copied onto every contact the import creates. But a
-- string inside a jsonb blob cannot be the thing docs/06 describes: it has no
-- timestamp of its own, no attribution to a person, and nothing stops it
-- being edited afterwards to say something else.
--
-- This table is the evidence. docs/02 says why it matters: "This is what lets
-- you defend a workspace when a provider or a regulator asks, and it is what
-- lets you suspend a workspace that lied."
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS consent_attestations;


-- ---------------------------------------------------------------------------
-- consent_attestations
--
-- Append-only. There is no UPDATE path in the repository and no unique
-- constraint that would force one: an attestation is a record of something a
-- person asserted at a moment, and a record you can edit afterwards is not
-- evidence of anything. Re-attesting writes a second row.
--
-- `subject_kind` covers both halves of the docs/06 sentence rather than
-- splitting into two near-identical tables. The alternative was
-- `import_consent` and `campaign_consent`, which differ only in the foreign
-- key and would need every query about "what has this workspace asserted"
-- written twice — which is the query an investigation actually runs.

CREATE TABLE consent_attestations (
  id           uuid        PRIMARY KEY,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  subject_kind text        NOT NULL CHECK (subject_kind IN ('import', 'campaign')),
  subject_id   uuid        NOT NULL,

  -- Where the sender says the consent came from. A fixed vocabulary rather
  -- than free text, because "how many workspaces claim to be sending to a
  -- purchased list" has to be answerable with a GROUP BY, and free text
  -- makes it a reading exercise.
  source       text        NOT NULL CHECK (source IN (
                 'signup_form',
                 'checkout_optin',
                 'in_person',
                 'existing_customer',
                 'imported_from_previous_provider',
                 'other'
               )),

  -- The sender's own description. Required for 'other', which is what stops
  -- 'other' becoming the option everybody picks to avoid explaining.
  detail       text,

  -- What the campaign's audience looked like when this was asserted.
  --
  -- The attack this closes: attest about a small hand-built list, then swap
  -- the audience for a purchased one, then launch. Without it the attestation
  -- is about a campaign rather than about a list of people, and it would be
  -- satisfied by any audience at all.
  --
  -- NULL for imports, where the subject is the file itself.
  audience_fingerprint text,

  -- docs/06: "attributed to a user". Not nullable and not an API key: an
  -- attestation is somebody putting their name to a claim, and a key is not
  -- a somebody. ON DELETE RESTRICT so a departing user cannot take the
  -- attribution with them.
  attested_by  uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attested_at  timestamptz NOT NULL DEFAULT now(),

  -- For a dispute, months later, about which IP and which browser.
  attested_ip  inet,

  CONSTRAINT ck_ca_detail_for_other CHECK (
    source <> 'other' OR (detail IS NOT NULL AND length(btrim(detail)) >= 10)
  )
);

-- The lookup launch does: the newest attestation for this campaign.
CREATE INDEX ix_ca_subject ON consent_attestations
  (workspace_id, subject_kind, subject_id, attested_at DESC);

-- The lookup an investigation does: everything this workspace has claimed,
-- newest first.
CREATE INDEX ix_ca_workspace ON consent_attestations (workspace_id, attested_at DESC);


-- ---------------------------------------------------------------------------
-- Append-only, enforced
--
-- The repository has no UPDATE and no DELETE, but "the repository has no
-- method for it" is not a guarantee — a migration, a psql session or a
-- future repository can all still do it. Evidence that can be rewritten
-- after the fact is worth nothing in the dispute it exists for, so the
-- database refuses.
--
-- Same shape as the `metered` write-once trigger on campaign_recipients
-- (CLAUDE.md section 8, INVARIANTS R14).

CREATE OR REPLACE FUNCTION consent_attestations_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'consent_attestations is append-only: % on attestation % refused',
    TG_OP, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_attestations_append_only
  BEFORE UPDATE OR DELETE ON consent_attestations
  FOR EACH ROW EXECUTE FUNCTION consent_attestations_append_only();


-- ---------------------------------------------------------------------------
-- Row-level security

ALTER TABLE consent_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY consent_attestations_tenant ON consent_attestations
  USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
