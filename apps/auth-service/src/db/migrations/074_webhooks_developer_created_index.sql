CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhooks_developer_created
  ON webhooks (developer_id, created_at DESC);
