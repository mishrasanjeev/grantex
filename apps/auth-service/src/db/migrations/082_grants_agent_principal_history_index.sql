CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grants_agent_principal_history
  ON grants (developer_id, agent_id, principal_id, issued_at DESC);
