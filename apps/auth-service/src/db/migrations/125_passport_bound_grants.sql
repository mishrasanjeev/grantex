-- SPDX-License-Identifier: Apache-2.0
-- Passport binding at grant issuance (Agent Trust Registry, Phase 1; PRD §5
-- GrantPassportBinding, §8.4; spec/passport-binding.md).
--
-- With PASSPORT_BOUND_GRANTS_ENABLED=true, POST /v1/authorize may carry an
-- Agent Passport. Once the registry has checked it, the authorization request
-- records what the grant will be bound to (auth_requests.passport_binding),
-- and the code exchange copies that into grant_passport_bindings, one row per
-- bound grant. The grant token carries the same binding as an
-- authorization_details entry of type urn:grantex:commerce:v1 and cnf.jkt.
--
-- grant_passport_bindings is what a later cascade reads to find every grant
-- bound to a passport: by the issuer's attestation (issuer_entity_id,
-- attestation_id), by the registry's record, by the registry's acceptance
-- entry, and by the bound key. passport_hash is kept for audit, not indexed:
-- a relying party must not rely on the hash alone to deny
-- (spec/agent-passport-1.0.md §6).
--
-- Additive. One nullable column on auth_requests (no rewrite, no default)
-- and one new, empty table. grants.authorization_details is left alone: it
-- holds the tools entries evidence packages read, and the commerce entry is
-- rebuilt from this table at every issuance and refresh. No existing query
-- reads the new column or table, so nothing behaves differently until the
-- flag is turned on.

ALTER TABLE auth_requests
  ADD COLUMN IF NOT EXISTS passport_binding JSONB
  CONSTRAINT chk_auth_requests_passport_binding
    CHECK (passport_binding IS NULL OR jsonb_typeof(passport_binding) = 'object');

CREATE TABLE IF NOT EXISTS grant_passport_bindings (
  grant_id                 TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  developer_id             TEXT NOT NULL,
  agent_id                 TEXT NOT NULL,
  -- The passport's iss: the accredited issuer's entity_id.
  issuer_entity_id         TEXT NOT NULL,
  -- The passport's attestation_id, the issuer's id for the attestation.
  attestation_id           TEXT NOT NULL,
  -- registry_attestations.id. Deliberately not a foreign key, as the
  -- registry's own tables do not refer to agents: the binding outlives
  -- nothing it names, and no registry write is refused because of it.
  registry_attestation_id  TEXT NOT NULL,
  -- The attestation's external_credential_id: the issuer's id for the passport.
  external_credential_id   TEXT NOT NULL,
  -- Hash rule (spec/agent-passport-1.0.md §6).
  passport_hash            TEXT NOT NULL,
  -- RFC 7638 thumbprint of the passport's cnf key; the grant token's cnf.jkt.
  key_thumbprint           TEXT NOT NULL,
  -- The registry's acceptance entry for the attestation (migration 123).
  acceptance_list_uri      TEXT NOT NULL,
  acceptance_list_idx      INTEGER NOT NULL,
  -- The passport's exp. The grant's expires_at is at or before it, and a
  -- refresh is refused once it has passed (spec/passport-binding.md §5).
  passport_expires_at      TIMESTAMPTZ NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_grant_passport_bindings_hash CHECK (passport_hash ~ '^sha-256:[A-Za-z0-9_-]{43}$'),
  CONSTRAINT chk_grant_passport_bindings_thumbprint CHECK (key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT chk_grant_passport_bindings_idx CHECK (acceptance_list_idx >= 0)
);

CREATE INDEX IF NOT EXISTS idx_grant_passport_bindings_attestation
  ON grant_passport_bindings (issuer_entity_id, attestation_id);
CREATE INDEX IF NOT EXISTS idx_grant_passport_bindings_registry_attestation
  ON grant_passport_bindings (registry_attestation_id);
CREATE INDEX IF NOT EXISTS idx_grant_passport_bindings_acceptance
  ON grant_passport_bindings (acceptance_list_uri, acceptance_list_idx);
CREATE INDEX IF NOT EXISTS idx_grant_passport_bindings_key
  ON grant_passport_bindings (key_thumbprint);
