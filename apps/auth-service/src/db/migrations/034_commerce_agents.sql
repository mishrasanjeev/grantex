-- Grantex Commerce V1 — Milestone 1: CommerceAgent.
-- Distinct from existing platform `agents` table. Holds JWT public key
-- (preferred) and/or hashed API key (secondary) per spec §6 agent auth.

CREATE TABLE IF NOT EXISTS commerce_agents (
  id              TEXT PRIMARY KEY,                                     -- cag_<ulid>
  tenant_id       TEXT NOT NULL REFERENCES commerce_tenants(id),
  display_name    TEXT NOT NULL,
  agent_type      TEXT NOT NULL DEFAULT 'sales',                        -- sales | support | catalog | other
  public_key_jwk  JSONB,                                                -- ES256 public key for JWT assertion verification
  api_key_hash    TEXT,                                                 -- salted hash of grtx_agent_<secret>; never raw
  trust_status    TEXT NOT NULL DEFAULT 'pending',                      -- pending | trusted | suspended | disabled
  disabled_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commerce_agents_trust_status CHECK (
    trust_status IN ('pending','trusted','suspended','disabled')
  ),
  CONSTRAINT chk_commerce_agents_has_credential CHECK (
    public_key_jwk IS NOT NULL OR api_key_hash IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_agents_tenant_id
  ON commerce_agents(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_commerce_agents_tenant
  ON commerce_agents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commerce_agents_trust
  ON commerce_agents(trust_status);
