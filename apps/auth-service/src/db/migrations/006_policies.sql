-- Policy engine: auto-approve / auto-deny rules evaluated at /v1/authorize
CREATE TABLE IF NOT EXISTS policies (
  id              TEXT PRIMARY KEY,
  developer_id    TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  effect          TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  priority        INTEGER NOT NULL DEFAULT 0,
  -- Conditions (NULL = match any)
  agent_id        TEXT,
  principal_id    TEXT,
  scopes          TEXT[],          -- all requested scopes must be ⊆ this set
  time_of_day_start TEXT,          -- HH:MM (24h UTC), inclusive
  time_of_day_end   TEXT,          -- HH:MM (24h UTC), exclusive
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS policies_developer_id_idx ON policies (developer_id);
