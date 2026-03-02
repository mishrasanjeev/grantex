-- Usage metering: tracks daily API usage per developer
CREATE TABLE IF NOT EXISTS usage_daily (
  id          TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id),
  date        DATE NOT NULL,
  token_exchanges   INTEGER NOT NULL DEFAULT 0,
  authorizations    INTEGER NOT NULL DEFAULT 0,
  verifications     INTEGER NOT NULL DEFAULT 0,
  total_requests    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(developer_id, date)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_developer_date ON usage_daily(developer_id, date DESC);
