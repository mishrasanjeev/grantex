CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_commerce_products_active_listing
  ON commerce_products (tenant_id, merchant_id, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;
