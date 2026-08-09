CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anomalies_developer_detected
  ON anomalies (developer_id, detected_at DESC);
