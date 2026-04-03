-- Expand anomaly detection with custom rules, alert channels, and lifecycle

-- Add alert lifecycle columns to existing anomalies table
ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS rule_id TEXT;
ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS rule_name TEXT;
ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS context JSONB NOT NULL DEFAULT '{}';
ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE anomalies ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- Custom detection rules
CREATE TABLE IF NOT EXISTS anomaly_rules (
  id                TEXT PRIMARY KEY,
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  rule_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  condition         JSONB NOT NULL,
  severity          TEXT NOT NULL DEFAULT 'medium',
  alert_channels    TEXT[] NOT NULL DEFAULT '{}',
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_rules_developer ON anomaly_rules(developer_id);

-- Notification channels
CREATE TABLE IF NOT EXISTS anomaly_channels (
  id                TEXT PRIMARY KEY,
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  type              TEXT NOT NULL,
  name              TEXT NOT NULL,
  config            JSONB NOT NULL,
  severities        TEXT[] NOT NULL DEFAULT '{critical,high}',
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anomaly_channels_developer ON anomaly_channels(developer_id);
