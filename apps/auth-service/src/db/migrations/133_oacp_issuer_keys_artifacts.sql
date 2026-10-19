-- SPDX-License-Identifier: Apache-2.0
-- OACP artifact authority: issuer keys, issued and refused artifacts, and the
-- OACP Token Status List (draft-ietf-oauth-status-list) that every issued
-- artifact is listed on.
--
--   oacp_issuer_keys       ES256 (P-256) keys that sign OACP artifacts as
--                          detached JWS. Private JWK encrypted with the vault
--                          key, bound to the kid (lib/vault-crypto.ts
--                          encryptWithContext). Published in
--                          /.well-known/jwks.json while active, and while
--                          retired until every artifact they signed expired.
--                          Revoked keys are withdrawn.
--   oacp_status_lists      one row per published list, served at
--   oacp_status_entries    GET /status/oacp/:list (2 bits per entry).
--   oacp_artifacts         every artifact issued, and every refused issuance,
--                          by the C6Z authority route and by revocation.
--
-- The keys and lists are the platform's own, as for commerce passport keys
-- and registry acceptance lists: no tenant column. oacp_artifacts carries the
-- tenant, merchant and seller-agent scope of each artifact; the routes filter
-- on it. tenant_id is the AgenticOrg tenant reference named in the authority
-- request, not a commerce_tenants row, so it has no foreign key.
--
-- Additive: four new tables, created empty.

CREATE TABLE IF NOT EXISTS oacp_issuer_keys (
  kid                       TEXT PRIMARY KEY,
  algorithm                 TEXT NOT NULL,
  public_key_jwk            JSONB NOT NULL,
  encrypted_private_key_jwk TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at                TIMESTAMPTZ,
  revoked_at                TIMESTAMPTZ,
  CONSTRAINT chk_oacp_issuer_keys_kid_format CHECK (kid ~ '^oacp-[0-9]{8}-[a-f0-9]{16}$'),
  CONSTRAINT chk_oacp_issuer_keys_algorithm CHECK (algorithm = 'ES256'),
  CONSTRAINT chk_oacp_issuer_keys_status CHECK (status IN ('active', 'retired', 'revoked')),
  CONSTRAINT chk_oacp_issuer_keys_retired_at CHECK (status <> 'retired' OR retired_at IS NOT NULL),
  CONSTRAINT chk_oacp_issuer_keys_revoked_at CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

-- Exactly one active key at a time; rotation retires it in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_oacp_issuer_keys_active
  ON oacp_issuer_keys (status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS oacp_status_lists (
  id          TEXT PRIMARY KEY,
  capacity    INTEGER NOT NULL,
  -- Entries handed out. Indices are drawn at random, so this is a count.
  allocated   INTEGER NOT NULL DEFAULT 0,
  -- Bumped by every status change, so the published token and its ETag
  -- change exactly when the content does.
  version     BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_oacp_status_lists_id CHECK (id ~ '^oacpl_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT chk_oacp_status_lists_capacity CHECK (capacity > 0 AND capacity % 8 = 0),
  CONSTRAINT chk_oacp_status_lists_allocated CHECK (allocated >= 0 AND allocated <= capacity),
  CONSTRAINT chk_oacp_status_lists_version CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS idx_oacp_status_lists_created
  ON oacp_status_lists (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS oacp_status_entries (
  list_id     TEXT NOT NULL REFERENCES oacp_status_lists(id),
  idx         INTEGER NOT NULL,
  -- draft-ietf-oauth-status-list §7.1: 0 VALID, 1 INVALID (revoked, final),
  -- 2 SUSPENDED.
  status      SMALLINT NOT NULL DEFAULT 0,
  artifact_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The primary key makes an index impossible to hand out twice.
  PRIMARY KEY (list_id, idx),
  CONSTRAINT uq_oacp_status_entries_artifact UNIQUE (artifact_id),
  CONSTRAINT chk_oacp_status_entries_idx CHECK (idx >= 0),
  CONSTRAINT chk_oacp_status_entries_status CHECK (status IN (0, 1, 2))
);

-- A published list reads only the entries that are not VALID.
CREATE INDEX IF NOT EXISTS idx_oacp_status_entries_not_valid
  ON oacp_status_entries (list_id)
  WHERE status <> 0;

CREATE OR REPLACE FUNCTION oacp_status_entry_in_capacity() RETURNS trigger AS $$
DECLARE
  list_capacity INTEGER;
BEGIN
  SELECT capacity INTO list_capacity FROM oacp_status_lists WHERE id = NEW.list_id;
  IF list_capacity IS NULL OR NEW.idx >= list_capacity THEN
    RAISE EXCEPTION 'oacp status index % is outside the capacity of list %', NEW.idx, NEW.list_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_oacp_status_entry_in_capacity ON oacp_status_entries;
CREATE TRIGGER trg_oacp_status_entry_in_capacity
  BEFORE INSERT OR UPDATE OF list_id, idx ON oacp_status_entries
  FOR EACH ROW EXECUTE FUNCTION oacp_status_entry_in_capacity();

CREATE TABLE IF NOT EXISTS oacp_artifacts (
  artifact_id            TEXT PRIMARY KEY,
  family                 TEXT NOT NULL,
  artifact_type          TEXT,
  tenant_id              TEXT,
  merchant_id            TEXT,
  seller_agent_id        TEXT,
  issuer_key_id          TEXT REFERENCES oacp_issuer_keys(kid),
  payload_hash           TEXT,
  -- Detached compact JWS, as carried in envelope.signature.
  jws                    TEXT,
  envelope               JSONB,
  -- The artifact payload; for a refusal, the refusal record.
  payload                JSONB NOT NULL,
  status_list_uri        TEXT,
  status_idx             INTEGER,
  request_id             TEXT,
  issued_at              TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,
  status                 TEXT NOT NULL,
  refusal_code           TEXT,
  revoked_at             TIMESTAMPTZ,
  revocation_reason      TEXT,
  revocation_artifact_id TEXT REFERENCES oacp_artifacts(artifact_id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_oacp_artifacts_id CHECK (artifact_id ~ '^oacp_(art|ref)_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT chk_oacp_artifacts_status CHECK (status IN ('issued', 'refused', 'revoked')),
  -- An issued or revoked row is a signed artifact on a status list.
  CONSTRAINT chk_oacp_artifacts_signed CHECK (
    status = 'refused' OR (
      artifact_type IS NOT NULL AND tenant_id IS NOT NULL AND issuer_key_id IS NOT NULL
      AND payload_hash ~ '^[0-9a-f]{64}$' AND jws IS NOT NULL AND envelope IS NOT NULL
      AND status_list_uri IS NOT NULL AND status_idx IS NOT NULL
      AND issued_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at >= issued_at
      AND refusal_code IS NULL
    )
  ),
  -- A refusal is a record, never a signed artifact.
  CONSTRAINT chk_oacp_artifacts_refused CHECK (
    status <> 'refused' OR (
      refusal_code IS NOT NULL AND jws IS NULL AND envelope IS NULL
      AND status_list_uri IS NULL AND status_idx IS NULL
    )
  ),
  CONSTRAINT chk_oacp_artifacts_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- Replay for one tenant, optionally one merchant or seller agent, in order.
CREATE INDEX IF NOT EXISTS idx_oacp_artifacts_tenant_created
  ON oacp_artifacts (tenant_id, created_at, artifact_id);
-- JWKS publication: is any unexpired artifact still signed by a retired key?
CREATE INDEX IF NOT EXISTS idx_oacp_artifacts_issuer_key_expires
  ON oacp_artifacts (issuer_key_id, expires_at)
  WHERE status <> 'refused';
