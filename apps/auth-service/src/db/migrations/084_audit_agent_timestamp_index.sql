CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_agent_timestamp
  ON audit_entries (developer_id, agent_id, timestamp DESC);
