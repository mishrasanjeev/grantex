CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_deliveries_webhook_created
  ON webhook_deliveries (webhook_id, created_at DESC);
