CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_commerce_variants_active_product_listing
  ON commerce_product_variants (tenant_id, merchant_id, product_id, created_at ASC)
  WHERE archived_at IS NULL;
