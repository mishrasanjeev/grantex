-- Grantex Commerce V1 — Milestone 1: CommerceProduct + CommerceProductVariant.
-- Soft-delete via archived_at. Hard-deletes are forbidden when references
-- exist (cart/payment/audit FKs land in later migrations).

CREATE TABLE IF NOT EXISTS commerce_products (
  id                    TEXT PRIMARY KEY,                                       -- cprd_<ulid>
  tenant_id             TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id           TEXT NOT NULL REFERENCES commerce_merchants(id),
  product_id            TEXT NOT NULL,                                          -- merchant-supplied stable product key
  title                 TEXT NOT NULL,
  brand                 TEXT,
  description           TEXT,
  image_url             TEXT,
  category_preset       TEXT NOT NULL REFERENCES commerce_category_presets(preset_key),
  source_system         TEXT NOT NULL DEFAULT 'manual',                         -- manual | csv | api | webhook
  manually_maintained   BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Spec §15: (tenant_id, merchant_id, product_id) unique for active rows.
-- Partial index lets soft-deleted rows keep the same product_id without
-- blocking fresh re-creation under the same key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_products_active
  ON commerce_products(tenant_id, merchant_id, product_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_commerce_products_tenant_merchant
  ON commerce_products(tenant_id, merchant_id);
CREATE INDEX IF NOT EXISTS idx_commerce_products_archived
  ON commerce_products(archived_at) WHERE archived_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS commerce_product_variants (
  id                        TEXT PRIMARY KEY,                                   -- cvar_<ulid>
  tenant_id                 TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id               TEXT NOT NULL REFERENCES commerce_merchants(id),
  product_id                TEXT NOT NULL REFERENCES commerce_products(id),
  sku                       TEXT NOT NULL,
  parent_sku                TEXT,
  model                     TEXT,
  variant_title             TEXT,
  attributes                JSONB NOT NULL DEFAULT '{}'::JSONB,
  price_amount              BIGINT NOT NULL,                                    -- minor currency units, tax-inclusive when tax_inclusive = TRUE
  currency                  TEXT NOT NULL DEFAULT 'INR',
  tax_inclusive             BOOLEAN NOT NULL DEFAULT TRUE,
  gst_slab                  TEXT,                                               -- e.g. "18", "28"
  tax_rate                  NUMERIC(6,4),                                       -- alternative to gst_slab for non-GST jurisdictions
  hsn_code                  TEXT,
  availability_status       TEXT NOT NULL DEFAULT 'unknown',                    -- in_stock | out_of_stock | pre_order | back_order | unknown
  warranty_summary          TEXT,
  return_policy_summary     TEXT,
  source_system             TEXT NOT NULL DEFAULT 'manual',
  last_synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at               TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_variant_availability CHECK (
    availability_status IN ('in_stock','out_of_stock','pre_order','back_order','unknown')
  ),
  CONSTRAINT chk_variant_price_nonneg CHECK (price_amount >= 0)
);

-- Spec §15: SKU unique per (tenant, merchant) for active variants. Partial
-- index permits archive-and-recreate workflows without losing the SKU key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_variants_active_sku
  ON commerce_product_variants(tenant_id, merchant_id, sku)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_commerce_variants_product
  ON commerce_product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_commerce_variants_tenant_merchant
  ON commerce_product_variants(tenant_id, merchant_id);
CREATE INDEX IF NOT EXISTS idx_commerce_variants_availability
  ON commerce_product_variants(availability_status);
