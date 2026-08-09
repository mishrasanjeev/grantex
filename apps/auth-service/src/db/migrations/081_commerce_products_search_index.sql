CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_commerce_products_search_trgm
  ON commerce_products USING GIN (
    (COALESCE(title, '') || ' ' || COALESCE(brand, '') || ' ' || product_id) gin_trgm_ops
  )
  WHERE archived_at IS NULL;
