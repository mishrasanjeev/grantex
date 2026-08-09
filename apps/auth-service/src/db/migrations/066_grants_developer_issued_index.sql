CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grants_developer_issued
  ON grants (developer_id, issued_at DESC);
