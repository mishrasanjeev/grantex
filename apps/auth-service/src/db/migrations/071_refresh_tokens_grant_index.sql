CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_refresh_tokens_grant
  ON refresh_tokens (grant_id);
