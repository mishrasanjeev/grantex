CREATE TABLE IF NOT EXISTS anomalies (
  id             TEXT PRIMARY KEY,
  developer_id   TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('rate_spike', 'high_failure_rate', 'new_principal', 'off_hours_activity')),
  severity       TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  agent_id       TEXT,
  principal_id   TEXT,
  description    TEXT NOT NULL,
  metadata       JSONB NOT NULL DEFAULT '{}',
  detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS anomalies_developer_id_idx ON anomalies (developer_id);
CREATE INDEX IF NOT EXISTS anomalies_detected_at_idx  ON anomalies (detected_at DESC);
