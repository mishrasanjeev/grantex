CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_anomalies_status_listing
  ON anomalies (developer_id, status, detected_at DESC);
