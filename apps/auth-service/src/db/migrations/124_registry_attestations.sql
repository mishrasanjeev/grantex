-- SPDX-License-Identifier: Apache-2.0
-- Registry attestations (Agent Trust Registry, Phase 1; PRD §5, §7
-- Attestation, §8.3, Appendix A) and what the computed trust level needs.
--
-- registry_attestations keeps every attestation an accredited issuer posted
-- and the registry accepted: the compact JWS exactly as received, the members
-- the registry reads from it, the issuer's status list entry, the registry's
-- own acceptance entry (migration 123), and two independent states:
--
--   state          the registry's record: accepted, withdrawn (by the issuer
--                  or the operator) or superseded (replaced by a refresh)
--   issuer_status  what the issuer's own Token Status List said when the
--                  registry last read it: valid, revoked or suspended
--
-- issuer_status_fresh_until bounds how long that read is relied on (the
-- list's exp, the time of reading plus its ttl, and at most a day); past it
-- the attestation no longer counts toward a level until the list is read
-- again (workers/registryIssuerStatusRecheck.ts).
--
-- Additive. Two new tables, created empty; new nullable or constant-default
-- columns on trust_registry and agents; one trigger on trust_registry that
-- only writes the new computed_trust_level column. trust_level keeps its
-- free-text values and every existing reader keeps reading it unchanged.
-- There are no foreign keys to agents or trust_registry, so no existing
-- delete path is refused because an attestation names its row.

CREATE TABLE IF NOT EXISTS registry_attestations (
  id                        TEXT PRIMARY KEY,
  issuer_id                 TEXT NOT NULL REFERENCES accredited_issuers(id),
  -- The payload's iss: the issuer's entity_id.
  issuer_entity_id          TEXT NOT NULL,
  -- The payload's id: minted by the issuer, unique per issuer only.
  attestation_id            TEXT NOT NULL,
  -- The compact JWS, byte for byte as posted.
  jws                       TEXT NOT NULL,
  received_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sub                       TEXT NOT NULL,
  subject_kind              TEXT NOT NULL,
  -- The subject's row: agents.id or trust_registry.id. Deliberately not a
  -- foreign key (see above).
  agent_id                  TEXT,
  provider_id               TEXT,
  type                      TEXT NOT NULL,
  key_thumbprint            TEXT,
  external_credential_id    TEXT NOT NULL,
  external_credential_hash  TEXT NOT NULL,
  -- The issuer's level, verbatim. The registry never interprets it.
  level                     TEXT NOT NULL,
  declared_limits           JSONB,
  iat                       TIMESTAMPTZ NOT NULL,
  exp                       TIMESTAMPTZ NOT NULL,
  -- The issuer's status list entry (payload status.status_list).
  status_list_uri           TEXT NOT NULL,
  status_list_idx           INTEGER NOT NULL,
  -- The registry's acceptance entry (lib/registry/acceptance-status.ts).
  acceptance_list_uri       TEXT NOT NULL,
  acceptance_list_idx       INTEGER NOT NULL,
  state                     TEXT NOT NULL DEFAULT 'accepted',
  issuer_status             TEXT NOT NULL DEFAULT 'valid',
  -- When the registry last tried to read the issuer's list, successfully or not.
  issuer_status_checked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Until when the last successful read may be relied on. No default: the
  -- writer always knows it from the list it read.
  issuer_status_fresh_until TIMESTAMPTZ NOT NULL,
  -- A refresh links the two records both ways.
  supersedes                TEXT REFERENCES registry_attestations(id),
  superseded_by             TEXT REFERENCES registry_attestations(id),
  withdrawn_at              TIMESTAMPTZ,
  superseded_at             TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_registry_attestations_issuer_id UNIQUE (issuer_entity_id, attestation_id),
  CONSTRAINT uq_registry_attestations_acceptance UNIQUE (acceptance_list_uri, acceptance_list_idx),
  CONSTRAINT chk_registry_attestations_state CHECK (state IN ('accepted', 'withdrawn', 'superseded')),
  CONSTRAINT chk_registry_attestations_issuer_status CHECK (issuer_status IN ('valid', 'revoked', 'suspended')),
  CONSTRAINT chk_registry_attestations_type CHECK (type IN (
    'urn:grantex:tm:provider.entity',
    'urn:grantex:tm:provider.ownership',
    'urn:grantex:tm:provider.screening',
    'urn:grantex:tm:agent.identity',
    'urn:grantex:tm:agent.security'
  )),
  -- An agent attestation names the agent and its key; a provider
  -- attestation names the provider and no key.
  CONSTRAINT chk_registry_attestations_subject CHECK (
    (subject_kind = 'agent' AND agent_id IS NOT NULL AND provider_id IS NULL
      AND key_thumbprint IS NOT NULL AND type LIKE 'urn:grantex:tm:agent.%')
    OR (subject_kind = 'provider' AND provider_id IS NOT NULL AND agent_id IS NULL
      AND key_thumbprint IS NULL AND type LIKE 'urn:grantex:tm:provider.%')
  ),
  CONSTRAINT chk_registry_attestations_hash CHECK (external_credential_hash ~ '^sha-256:[A-Za-z0-9_-]{43}$'),
  CONSTRAINT chk_registry_attestations_times CHECK (exp > iat),
  CONSTRAINT chk_registry_attestations_idx CHECK (status_list_idx >= 0 AND acceptance_list_idx >= 0),
  CONSTRAINT chk_registry_attestations_limits CHECK (declared_limits IS NULL OR jsonb_typeof(declared_limits) = 'object'),
  CONSTRAINT chk_registry_attestations_withdrawn CHECK (state <> 'withdrawn' OR withdrawn_at IS NOT NULL),
  CONSTRAINT chk_registry_attestations_superseded CHECK (state <> 'superseded' OR superseded_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_registry_attestations_agent
  ON registry_attestations (agent_id, received_at DESC) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_registry_attestations_provider
  ON registry_attestations (provider_id, received_at DESC) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_registry_attestations_issuer
  ON registry_attestations (issuer_id);
-- The recheck worker's queue: accepted attestations whose read is due.
CREATE INDEX IF NOT EXISTS idx_registry_attestations_recheck
  ON registry_attestations (issuer_status_fresh_until)
  WHERE state = 'accepted' AND issuer_status <> 'revoked';

-- Nonces of the issuer-signed withdrawal and refresh requests, so each is
-- used once. Rows past expires_at are deleted as new ones arrive.
CREATE TABLE IF NOT EXISTS registry_attestation_request_nonces (
  issuer_entity_id  TEXT NOT NULL,
  nonce             TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issuer_entity_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_registry_attestation_request_nonces_expiry
  ON registry_attestation_request_nonces (expires_at);

-- The provider record. trust_level stays free text and keeps its meaning for
-- the readers that use it (only 'verified' counts as verified). The computed
-- level of PRD §5.1 is a separate column with a closed set of values.
ALTER TABLE trust_registry
  ADD COLUMN IF NOT EXISTS legal_identifiers JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT chk_trust_registry_legal_identifiers CHECK (jsonb_typeof(legal_identifiers) = 'array'),
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  -- The attested half of the stored level, written by the registry only, so
  -- that a suspension (which reads basic) does not lose it.
  ADD COLUMN IF NOT EXISTS computed_attested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS computed_trust_level TEXT NOT NULL DEFAULT 'basic'
    CONSTRAINT chk_trust_registry_computed_trust_level
      CHECK (computed_trust_level IN ('basic', 'verified', 'attested', 'attested_verified'));

-- Derive computed_trust_level on every write: the verified half from DNS
-- verification, whichever route writes trust_level, and the attested half
-- from computed_attested, which the registry (lib/registry/trust-level.ts)
-- rewrites whenever a provider attestation changes. A provider suspended now
-- reads basic; lifting the suspension restores the attested half. The value
-- is a snapshot for display and search: it does not follow an attestation
-- expiring, a stale issuer status or an issuer suspension until the next
-- write, and policy reads the level computed at call time instead.
CREATE OR REPLACE FUNCTION grantex_trust_registry_computed_level() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  attested BOOLEAN;
  verified BOOLEAN;
BEGIN
  attested := NEW.computed_attested;
  verified := NEW.trust_level = 'verified' AND NEW.verified_at IS NOT NULL;
  IF NEW.suspended_at IS NOT NULL AND NEW.suspended_at <= NOW() THEN
    NEW.computed_trust_level := 'basic';
  ELSIF attested AND verified THEN
    NEW.computed_trust_level := 'attested_verified';
  ELSIF attested THEN
    NEW.computed_trust_level := 'attested';
  ELSIF verified THEN
    NEW.computed_trust_level := 'verified';
  ELSE
    NEW.computed_trust_level := 'basic';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER trust_registry_computed_level_trg
  BEFORE INSERT OR UPDATE OF trust_level, verified_at, suspended_at, computed_attested, computed_trust_level ON trust_registry
  FOR EACH ROW EXECUTE FUNCTION grantex_trust_registry_computed_level();

-- Backfill: a provider already DNS-verified reads verified. The trigger
-- derives the value; updated_at is left as it was.
UPDATE trust_registry SET computed_trust_level = 'verified'
WHERE trust_level = 'verified' AND verified_at IS NOT NULL;

-- What the agent declares about itself (PRD §5 Agent): its client metadata
-- document and its declared purpose, categories, scopes, autonomy and
-- limits. Nullable or empty by default; nothing existing reads them.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS cimd_uri TEXT
    CONSTRAINT chk_agents_cimd_uri CHECK (cimd_uri IS NULL OR (cimd_uri LIKE 'https://%' AND length(cimd_uri) <= 2048)),
  ADD COLUMN IF NOT EXISTS declared_purpose TEXT
    CONSTRAINT chk_agents_declared_purpose CHECK (declared_purpose IS NULL OR length(declared_purpose) <= 1000),
  ADD COLUMN IF NOT EXISTS declared_categories TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS declared_scopes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS declared_autonomy TEXT
    CONSTRAINT chk_agents_declared_autonomy CHECK (declared_autonomy IS NULL OR length(declared_autonomy) <= 64),
  ADD COLUMN IF NOT EXISTS declared_limits JSONB
    CONSTRAINT chk_agents_declared_limits CHECK (declared_limits IS NULL OR jsonb_typeof(declared_limits) = 'object');
