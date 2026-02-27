-- SCIM bearer tokens (one or more per developer org)
CREATE TABLE IF NOT EXISTS scim_tokens (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scim_tokens_developer_id_idx ON scim_tokens (developer_id);

-- SCIM provisioned users (principals synced from an enterprise IdP)
CREATE TABLE IF NOT EXISTS scim_users (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  external_id  TEXT,
  user_name    TEXT NOT NULL,
  display_name TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  emails       JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (developer_id, user_name)
);

CREATE INDEX IF NOT EXISTS scim_users_developer_id_idx ON scim_users (developer_id);

-- SSO OIDC configs (one per developer org)
CREATE TABLE IF NOT EXISTS sso_configs (
  developer_id  TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
  issuer_url    TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
