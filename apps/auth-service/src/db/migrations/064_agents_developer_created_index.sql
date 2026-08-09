CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_developer_created
  ON agents (developer_id, created_at DESC);
