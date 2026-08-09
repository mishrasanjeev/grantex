CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_developer_timestamp
  ON audit_entries (developer_id, timestamp DESC, id DESC);
