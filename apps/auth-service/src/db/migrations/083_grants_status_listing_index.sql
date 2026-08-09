CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grants_status_listing
  ON grants (developer_id, status, issued_at DESC);
