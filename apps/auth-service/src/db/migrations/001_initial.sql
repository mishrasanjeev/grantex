CREATE TABLE IF NOT EXISTS developers (
  id           TEXT PRIMARY KEY,
  api_key_hash TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  did          TEXT NOT NULL UNIQUE,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_requests (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  principal_id TEXT NOT NULL,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  scopes       TEXT[] NOT NULL,
  redirect_uri TEXT,
  state        TEXT,
  expires_in   TEXT NOT NULL DEFAULT '24h',
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  code         TEXT UNIQUE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grants (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  principal_id TEXT NOT NULL,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  scopes       TEXT[] NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  issued_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS grant_tokens (
  jti        TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL REFERENCES grants(id),
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL REFERENCES grants(id),
  is_used    BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_entries (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  agent_did     TEXT NOT NULL,
  grant_id      TEXT NOT NULL,
  principal_id  TEXT NOT NULL,
  developer_id  TEXT NOT NULL,
  action        TEXT NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}',
  hash          TEXT NOT NULL,
  previous_hash TEXT,
  timestamp     TIMESTAMPTZ DEFAULT NOW()
);
