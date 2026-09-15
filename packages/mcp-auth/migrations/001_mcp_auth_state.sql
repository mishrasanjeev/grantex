-- @grantex/mcp-auth durable authorization state.
--
-- Forward-only and idempotent: runMigrations() applies each file once, in
-- name order, under an advisory lock, and records it in
-- mcp_auth_schema_migrations. Bearer secrets presented by clients (codes,
-- refresh tokens, consent and pending-authorization ids) are stored only as
-- SHA-256 lookup keys, and client secrets only as hashes. `record` holds the
-- binding data in clear JSON: client, redirect URI, PKCE challenge, scopes,
-- resource and, for an issued authorization code, the upstream Grantex code
-- (`grantexCode`) the server exchanges at /token. That upstream code is
-- single use and lives at most codeExpirationSeconds, but it is a credential:
-- restrict access to these tables and their backups accordingly.

CREATE TABLE IF NOT EXISTS mcp_auth_clients (
  client_id    TEXT PRIMARY KEY,
  registration JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Authorizations waiting for the Principal's upstream consent.
CREATE TABLE IF NOT EXISTS mcp_auth_pending_authorizations (
  key        TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  record     JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_pending_authorizations_expires_at
  ON mcp_auth_pending_authorizations (expires_at);

-- Single-use authorization codes with their PKCE S256 challenges.
CREATE TABLE IF NOT EXISTS mcp_auth_authorization_codes (
  key        TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  record     JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_authorization_codes_expires_at
  ON mcp_auth_authorization_codes (expires_at);

-- Which client each refresh token was issued to.
CREATE TABLE IF NOT EXISTS mcp_auth_refresh_token_bindings (
  key        TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  record     JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_refresh_token_bindings_expires_at
  ON mcp_auth_refresh_token_bindings (expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_refresh_token_bindings_client_id
  ON mcp_auth_refresh_token_bindings (client_id);

-- Consent-page decisions awaiting form submission (one use each).
CREATE TABLE IF NOT EXISTS mcp_auth_consents (
  key        TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  record     JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_consents_expires_at
  ON mcp_auth_consents (expires_at);

-- Tokens revoked through this server, keyed by jti, kept until the token
-- would have expired.
CREATE TABLE IF NOT EXISTS mcp_auth_revocations (
  key        TEXT PRIMARY KEY,
  client_id  TEXT,
  record     JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_revocations_expires_at
  ON mcp_auth_revocations (expires_at);
