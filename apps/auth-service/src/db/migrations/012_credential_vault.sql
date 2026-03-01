-- Credential vault for encrypted per-user credential storage
CREATE TABLE IF NOT EXISTS vault_credentials (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  service       TEXT NOT NULL,
  credential_type TEXT NOT NULL DEFAULT 'oauth2',
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_credentials_unique
  ON vault_credentials (developer_id, principal_id, service);

CREATE INDEX IF NOT EXISTS idx_vault_credentials_principal
  ON vault_credentials (developer_id, principal_id);
