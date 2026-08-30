-- Standards endpoints and refresh-family state for the OAuth agent-grants profile.

CREATE TABLE IF NOT EXISTS oauth_par_requests (
  request_uri           TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  developer_id          TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  redirect_uri          TEXT NOT NULL,
  scopes                TEXT[] NOT NULL,
  state                 TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  resource              TEXT NOT NULL,
  dpop_jkt              TEXT NOT NULL,
  principal_hint        TEXT,
  authorization_details JSONB,
  status                TEXT NOT NULL DEFAULT 'pushed',
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_par_requests_expiry
  ON oauth_par_requests (expires_at);

ALTER TABLE auth_requests
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'grantex-v1';

ALTER TABLE auth_requests
  ADD COLUMN IF NOT EXISTS authorization_details JSONB;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS key_verified_thumbprint TEXT;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS key_verified_at TIMESTAMPTZ;

-- An Agent Key identifies one runtime instance. Reusing the same key across
-- registrations would collapse those instances and violate sender binding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_key_thumbprint_unique
  ON agents (key_thumbprint)
  WHERE key_thumbprint IS NOT NULL;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'grantex-v1';

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS authorization_details JSONB;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS family_id TEXT;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS parent_token_id TEXT;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
  ON refresh_tokens (family_id);
