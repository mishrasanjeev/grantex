-- Policy bundles for policy-as-code git sync
CREATE TABLE IF NOT EXISTS policy_bundles (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id),
  format        TEXT NOT NULL CHECK (format IN ('rego', 'cedar')),
  version       TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  content       BYTEA NOT NULL,
  file_count    INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_policy_bundles_developer ON policy_bundles(developer_id);
CREATE INDEX IF NOT EXISTS idx_policy_bundles_active ON policy_bundles(developer_id, active) WHERE active = TRUE;
