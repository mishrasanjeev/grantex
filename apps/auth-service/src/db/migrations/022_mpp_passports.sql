-- MPP Agent Passports and Trust Registry
-- Adds tables for AgentPassportCredential issuance and org trust records.

CREATE TABLE IF NOT EXISTS mpp_passports (
  id              TEXT PRIMARY KEY,               -- urn:grantex:passport:<ulid>
  developer_id    TEXT NOT NULL REFERENCES developers(id),
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  grant_id        TEXT NOT NULL REFERENCES grants(id),
  principal_id    TEXT NOT NULL,
  agent_did       TEXT NOT NULL,
  organization_did TEXT NOT NULL,
  allowed_categories TEXT[] NOT NULL,
  max_amount      NUMERIC(20, 2) NOT NULL,
  max_currency    TEXT NOT NULL DEFAULT 'USDC',
  payment_rails   TEXT[] NOT NULL DEFAULT ARRAY['tempo'],
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  parent_passport_id TEXT REFERENCES mpp_passports(id),
  credential_jwt  TEXT NOT NULL,
  encoded_credential TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  status_list_idx INTEGER,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mpp_passports_developer ON mpp_passports(developer_id);
CREATE INDEX IF NOT EXISTS idx_mpp_passports_agent ON mpp_passports(agent_id);
CREATE INDEX IF NOT EXISTS idx_mpp_passports_grant ON mpp_passports(grant_id);

CREATE TABLE IF NOT EXISTS trust_registry (
  id                  TEXT PRIMARY KEY,
  organization_did    TEXT NOT NULL UNIQUE,
  domain              TEXT NOT NULL,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verification_method TEXT NOT NULL DEFAULT 'manual',
  trust_level         TEXT NOT NULL DEFAULT 'basic',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_registry_org_did ON trust_registry(organization_did);
