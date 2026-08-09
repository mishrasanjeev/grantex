CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_principal_timestamp
  ON audit_entries (developer_id, principal_id, timestamp DESC);
