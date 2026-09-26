-- Existing accounts retain their current automatic-revocation behavior.
ALTER TABLE developers
  ADD COLUMN IF NOT EXISTS irregularity_response_mode TEXT NOT NULL DEFAULT 'revoke_agent_grants';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'developers'::regclass
      AND conname = 'chk_irregularity_response_mode'
  ) THEN
    ALTER TABLE developers
      ADD CONSTRAINT chk_irregularity_response_mode
      CHECK (irregularity_response_mode IN ('revoke_agent_grants', 'alert_only'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS irregularity_policy_changes (
  id TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  previous_mode TEXT NOT NULL CHECK (previous_mode IN ('revoke_agent_grants', 'alert_only')),
  next_mode TEXT NOT NULL CHECK (next_mode IN ('revoke_agent_grants', 'alert_only')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_irregularity_policy_changes_developer
  ON irregularity_policy_changes (developer_id, changed_at DESC);
