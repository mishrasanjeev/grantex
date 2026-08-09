CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grants_parent
  ON grants (parent_grant_id);
