CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auth_requests_owner_agent
  ON auth_requests (developer_id, agent_id);
