CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_deliveries_status
  ON webhook_deliveries (webhook_id, status, created_at DESC);
