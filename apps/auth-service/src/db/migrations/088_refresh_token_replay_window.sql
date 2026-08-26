-- Preserve refresh-token rotation recovery metadata for a short retry window.
--
-- If a refresh request commits but the HTTP response is lost, the caller only
-- has the just-consumed refresh token. These columns let the server return the
-- already-rotated child refresh token during a tightly bounded replay window
-- without making refresh tokens generally reusable.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS rotated_to_token_id TEXT;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replay_expires_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'refresh_tokens_rotated_to_token_id_fkey'
  ) THEN
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_rotated_to_token_id_fkey
      FOREIGN KEY (rotated_to_token_id)
      REFERENCES refresh_tokens(id)
      ON DELETE SET NULL;
  END IF;
END $$;
