-- Enterprise SSO: multi-IdP connections (OIDC + SAML), sessions, enforcement
-- Extends the basic sso_configs table with full enterprise capabilities.

-- SSO connections (multiple per org, OIDC + SAML 2.0)
CREATE TABLE IF NOT EXISTS sso_connections (
  id              TEXT PRIMARY KEY,
  developer_id    TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  protocol        TEXT NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'testing')),

  -- OIDC fields
  issuer_url      TEXT,
  client_id       TEXT,
  client_secret   TEXT,

  -- SAML fields
  idp_entity_id   TEXT,
  idp_sso_url     TEXT,
  idp_certificate TEXT,
  sp_entity_id    TEXT,
  sp_acs_url      TEXT,

  -- Domain mapping (auto-route users by email domain)
  domains         TEXT[] NOT NULL DEFAULT '{}',

  -- JIT provisioning & enforcement
  jit_provisioning BOOLEAN NOT NULL DEFAULT false,
  enforce          BOOLEAN NOT NULL DEFAULT false,

  -- Group / role mapping
  group_attribute  TEXT,                          -- OIDC claim or SAML attribute name for groups
  group_mappings   JSONB NOT NULL DEFAULT '{}',   -- { "EngineerGroup": ["read","write"], "AdminGroup": ["admin"] }
  default_scopes   TEXT[] NOT NULL DEFAULT '{}',  -- fallback scopes when no group match

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_connections_developer_id_idx ON sso_connections (developer_id);

-- SSO sessions (track authenticated SSO logins)
CREATE TABLE IF NOT EXISTS sso_sessions (
  id              TEXT PRIMARY KEY,
  developer_id    TEXT NOT NULL,
  connection_id   TEXT NOT NULL REFERENCES sso_connections(id) ON DELETE CASCADE,
  principal_id    TEXT,
  email           TEXT,
  name            TEXT,
  idp_subject     TEXT,
  groups          TEXT[] NOT NULL DEFAULT '{}',
  mapped_scopes   TEXT[] NOT NULL DEFAULT '{}',
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sso_sessions_developer_id_idx ON sso_sessions (developer_id);
CREATE INDEX IF NOT EXISTS sso_sessions_connection_id_idx ON sso_sessions (connection_id);
CREATE INDEX IF NOT EXISTS sso_sessions_expires_at_idx   ON sso_sessions (expires_at);
