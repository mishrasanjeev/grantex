-- Replay responses contain bearer access tokens. Discard any legacy plaintext
-- cache exactly once before requiring AES-256-GCM envelopes for future writes.
-- The sentinel below is what makes that "exactly once" true. It predates the
-- schema_migrations ledger, which now applies each file at most once per
-- database, and it is kept because a database migrated before the ledger
-- existed ran this file on every start — the marker is the only record that
-- the one-time discard already happened, and without it a re-run would erase
-- valid encrypted recovery state.
CREATE TABLE IF NOT EXISTS grantex_migration_markers (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH newly_applied AS (
  INSERT INTO grantex_migration_markers (name)
  VALUES ('093_encrypt_refresh_replay_state')
  ON CONFLICT (name) DO NOTHING
  RETURNING name
)
UPDATE refresh_tokens
SET replay_expires_at = NULL,
    replay_request_hash = NULL,
    replay_jti = NULL,
    replay_issued_at = NULL,
    replay_grant_token = NULL
WHERE replay_grant_token IS NOT NULL
  AND EXISTS (SELECT 1 FROM newly_applied);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_replay_cleanup
  ON refresh_tokens (replay_expires_at)
  WHERE replay_expires_at IS NOT NULL;
