CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_grant_tokens_grant
  ON grant_tokens (grant_id);
