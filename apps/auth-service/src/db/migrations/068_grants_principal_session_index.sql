CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grants_principal_session
  ON grants (developer_id, principal_id, status, issued_at DESC);
