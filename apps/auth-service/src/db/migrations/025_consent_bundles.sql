-- Offline consent bundles for Gemma 4 on-device agents.
-- Stores issued bundles and synced offline audit entries.

CREATE TABLE IF NOT EXISTS consent_bundles (
  id                TEXT PRIMARY KEY,                -- bundle_<ulid>
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  grant_id          TEXT NOT NULL REFERENCES grants(id),
  user_id           TEXT NOT NULL,
  scopes            TEXT[] NOT NULL,
  device_id         TEXT,
  device_platform   TEXT,
  audit_public_key  TEXT NOT NULL,                   -- Ed25519 public key for offline audit verification
  offline_ttl       TEXT NOT NULL DEFAULT '72h',
  offline_expires_at TIMESTAMPTZ NOT NULL,
  checkpoint_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sync_at      TIMESTAMPTZ,
  audit_entry_count INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',  -- active | revoked | expired
  revoked_at        TIMESTAMPTZ,
  revoked_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_bundles_developer ON consent_bundles(developer_id);
CREATE INDEX IF NOT EXISTS idx_consent_bundles_agent ON consent_bundles(agent_id);
CREATE INDEX IF NOT EXISTS idx_consent_bundles_grant ON consent_bundles(grant_id);
CREATE INDEX IF NOT EXISTS idx_consent_bundles_status ON consent_bundles(status);

CREATE TABLE IF NOT EXISTS offline_audit_entries (
  id                TEXT PRIMARY KEY,                -- oae_<ulid>
  bundle_id         TEXT NOT NULL REFERENCES consent_bundles(id),
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  device_id         TEXT,
  seq               INTEGER NOT NULL,
  timestamp         TIMESTAMPTZ NOT NULL,
  action            TEXT NOT NULL,
  agent_did         TEXT NOT NULL,
  grant_id          TEXT NOT NULL,
  scopes            TEXT[] NOT NULL,
  result            TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}',
  prev_hash         TEXT NOT NULL,
  hash              TEXT NOT NULL,
  signature         TEXT NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_offline_audit_bundle ON offline_audit_entries(bundle_id);
CREATE INDEX IF NOT EXISTS idx_offline_audit_developer ON offline_audit_entries(developer_id);
CREATE INDEX IF NOT EXISTS idx_offline_audit_timestamp ON offline_audit_entries(timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_audit_bundle_seq ON offline_audit_entries(bundle_id, seq);
