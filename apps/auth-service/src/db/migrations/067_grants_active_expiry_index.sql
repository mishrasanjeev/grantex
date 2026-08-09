CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grants_active_expiry
  ON grants (developer_id, expires_at)
  WHERE status = 'active';
