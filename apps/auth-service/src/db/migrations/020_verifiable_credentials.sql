CREATE TABLE IF NOT EXISTS verifiable_credentials (
  id              TEXT PRIMARY KEY,
  grant_id        TEXT NOT NULL REFERENCES grants(id),
  developer_id    TEXT NOT NULL REFERENCES developers(id),
  principal_id    TEXT NOT NULL,
  agent_did       TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  format          TEXT NOT NULL DEFAULT 'jwt',
  credential_jwt  TEXT,
  credential_json JSONB,
  status          TEXT NOT NULL DEFAULT 'active',
  status_list_idx INTEGER,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vc_grant ON verifiable_credentials(grant_id);
CREATE INDEX IF NOT EXISTS idx_vc_developer ON verifiable_credentials(developer_id);

CREATE TABLE IF NOT EXISTS vc_status_lists (
  id             TEXT PRIMARY KEY,
  developer_id   TEXT NOT NULL REFERENCES developers(id),
  purpose        TEXT NOT NULL DEFAULT 'revocation',
  encoded_list   TEXT NOT NULL,
  size           INTEGER NOT NULL DEFAULT 131072,
  next_index     INTEGER NOT NULL DEFAULT 0,
  credential_jwt TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vc_status_list_dev_purpose
  ON vc_status_lists(developer_id, purpose);
