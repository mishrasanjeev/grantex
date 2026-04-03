-- MCP Server Registry and Certification
-- Adds tables for MCP server listings and certification workflow.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                TEXT PRIMARY KEY,           -- mcp_srv_<ulid>
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  name              TEXT NOT NULL,
  description       TEXT,
  server_url        TEXT,
  auth_endpoint     TEXT,
  npm_package       TEXT,
  category          TEXT NOT NULL DEFAULT 'other',  -- productivity | data | compute | payments | communication | other
  scopes            TEXT[] NOT NULL DEFAULT '{}',
  certified         BOOLEAN NOT NULL DEFAULT false,
  certification_level TEXT,                     -- bronze | silver | gold
  certified_at      TIMESTAMPTZ,
  weekly_active_agents INTEGER NOT NULL DEFAULT 0,
  stars             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_developer ON mcp_servers(developer_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_category ON mcp_servers(category);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_certified ON mcp_servers(certified);

CREATE TABLE IF NOT EXISTS mcp_certifications (
  id                TEXT PRIMARY KEY,           -- cert_<ulid>
  server_id         TEXT NOT NULL REFERENCES mcp_servers(id),
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  requested_level   TEXT NOT NULL,              -- bronze | silver | gold
  status            TEXT NOT NULL DEFAULT 'pending_conformance_test',
  conformance_results JSONB NOT NULL DEFAULT '{}',
  conformance_passed INTEGER NOT NULL DEFAULT 0,
  conformance_total  INTEGER NOT NULL DEFAULT 13,
  reviewed_at       TIMESTAMPTZ,
  reviewer_notes    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_certifications_server ON mcp_certifications(server_id);
