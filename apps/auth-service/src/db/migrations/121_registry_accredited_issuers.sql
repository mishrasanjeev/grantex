-- SPDX-License-Identifier: Apache-2.0
-- Accredited issuers in the registry (Agent Trust Registry, Phase 1): the
-- organisations whose Agent Passports and attestations the registry accepts,
-- the trust marks each is accredited for, and the keys it signs with.
--
-- Additive: two new tables, created empty. Only the operator routes
-- (POST and PATCH /v1/registry/issuers, REGISTRY_OPERATOR_API_KEYS) write
-- here; GET /v1/registry/issuers and lib/registry/issuers.ts read.
--
-- entity_id is an OpenID Federation Entity Identifier (OpenID Federation 1.0
-- section 1.2): an https URL with a host, no query and no fragment. The route
-- also refuses userinfo and non-canonical forms; the CHECKs below are the
-- floor the table holds whatever writes to it.
--
-- jwks is the static JWK Set recorded at accreditation. Resolving keys
-- through OpenID Federation is Phase 2. A kid revoked below is never served
-- again, even if a later replacement set carries it.
--
-- A suspension always carries the time it takes effect, which may be in the
-- future: until then the issuer stays accredited. accreditation_evidence_ref
-- is an opaque reference into the operator's own records, never the evidence.

CREATE TABLE IF NOT EXISTS accredited_issuers (
  id                          TEXT PRIMARY KEY,
  entity_id                   TEXT NOT NULL,
  did                         TEXT,
  jwks                        JSONB NOT NULL,
  trust_marks                 TEXT[] NOT NULL DEFAULT '{}',
  status                      TEXT NOT NULL DEFAULT 'active',
  suspended_effective_from    TIMESTAMPTZ,
  status_list_base            TEXT NOT NULL,
  events_endpoint             TEXT,
  data_residency              TEXT,
  accredited_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accreditation_evidence_ref  TEXT NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_accredited_issuers_entity_id UNIQUE (entity_id),
  CONSTRAINT chk_accredited_issuers_status CHECK (status IN ('active', 'suspended', 'withdrawn')),
  CONSTRAINT chk_accredited_issuers_suspension
    CHECK ((status = 'suspended') = (suspended_effective_from IS NOT NULL)),
  -- The Phase 1 trust mark taxonomy. A new mark needs a new migration.
  CONSTRAINT chk_accredited_issuers_trust_marks CHECK (trust_marks <@ ARRAY[
    'urn:grantex:tm:provider.entity',
    'urn:grantex:tm:provider.ownership',
    'urn:grantex:tm:provider.screening',
    'urn:grantex:tm:agent.identity',
    'urn:grantex:tm:agent.security'
  ]::TEXT[]),
  -- https, a host with no userinfo, no query, no fragment. A bare origin is
  -- stored without its trailing slash, so https://issuer.example and
  -- https://issuer.example/ cannot both be rows.
  CONSTRAINT chk_accredited_issuers_entity_id
    CHECK (entity_id ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]+)?$' AND length(entity_id) <= 2048),
  -- A prefix, so it ends in a slash: https://issuer.example/status must not
  -- also cover https://issuer.example/status-elsewhere.
  CONSTRAINT chk_accredited_issuers_status_list_base
    CHECK (status_list_base ~ '^https://[^/?#@[:space:]]+/([^?#[:space:]]*/)?$' AND length(status_list_base) <= 2048),
  CONSTRAINT chk_accredited_issuers_events_endpoint
    CHECK (events_endpoint IS NULL OR events_endpoint ~ '^https://[^/?#@[:space:]]+(/[^?#[:space:]]+)?$'),
  CONSTRAINT chk_accredited_issuers_jwks
    CHECK (jsonb_typeof(jwks -> 'keys') = 'array' AND octet_length(jwks::TEXT) <= 65536)
);

-- One row per revoked kid. Never deleted: revoking a kid is permanent for the
-- issuer, and revoked_at is when the registry stopped serving it.
CREATE TABLE IF NOT EXISTS accredited_issuer_revoked_keys (
  issuer_id   TEXT NOT NULL REFERENCES accredited_issuers(id) ON DELETE CASCADE,
  kid         TEXT NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason      TEXT NOT NULL,
  PRIMARY KEY (issuer_id, kid)
);
