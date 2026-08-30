-- Security metadata for OAuth-aligned agent grants and idempotent refresh recovery.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS redirect_uris TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS resource_servers TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS public_jwk JSONB;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS key_thumbprint TEXT;

ALTER TABLE auth_requests
  ADD COLUMN IF NOT EXISTS agent_key_thumbprint TEXT;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS agent_key_thumbprint TEXT;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replay_request_hash TEXT;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replay_jti TEXT;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replay_issued_at BIGINT;

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replay_grant_token TEXT;
