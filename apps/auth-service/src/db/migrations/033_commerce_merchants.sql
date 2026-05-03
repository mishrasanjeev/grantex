-- Grantex Commerce V1 — Milestone 1: CommerceMerchant.
-- Provider-neutral by construction: provider_account_refs is JSONB keyed by
-- provider_key (e.g. {"plural": {...}, "razorpay": {...}}). Core columns
-- carry no provider-specific identifiers.

CREATE TABLE IF NOT EXISTS commerce_merchants (
  id                          TEXT PRIMARY KEY,                                 -- mch_<ulid>
  tenant_id                   TEXT NOT NULL REFERENCES commerce_tenants(id),
  legal_name                  TEXT NOT NULL,
  display_name                TEXT NOT NULL,
  category_preset             TEXT NOT NULL REFERENCES commerce_category_presets(preset_key),
  verification_status         TEXT NOT NULL DEFAULT 'unverified',               -- unverified | pending | verified | rejected
  environment                 TEXT NOT NULL DEFAULT 'sandbox',                  -- sandbox | live
  agentic_commerce_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  default_currency            TEXT NOT NULL DEFAULT 'INR',
  country_code                TEXT NOT NULL DEFAULT 'IN',
  support_email               TEXT,
  provider_account_refs       JSONB NOT NULL DEFAULT '{}'::JSONB,
  metadata                    JSONB NOT NULL DEFAULT '{}'::JSONB,
  disabled_at                 TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_merchants_verification CHECK (
    verification_status IN ('unverified','pending','verified','rejected')
  ),
  CONSTRAINT chk_merchants_environment CHECK (environment IN ('sandbox','live')),
  -- Must be a CONSTRAINT (not a bare UNIQUE INDEX) so other tables can
  -- declare composite FOREIGN KEY (tenant_id, merchant_id) → here.
  -- PG requires a UNIQUE/PK constraint on the referenced columns; a
  -- standalone unique index is not accepted as an FK target.
  CONSTRAINT uq_commerce_merchants_tenant_id UNIQUE (tenant_id, id)
);

-- Idempotency for upgrades from a prior shape that used CREATE UNIQUE
-- INDEX. Drop the legacy index if present (the CONSTRAINT above creates
-- its own backing index automatically). No-op on fresh installs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'uq_commerce_merchants_tenant_id'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_commerce_merchants_tenant_id'
          AND conrelid = 'commerce_merchants'::regclass
      )
  ) THEN
    DROP INDEX uq_commerce_merchants_tenant_id;
    ALTER TABLE commerce_merchants
      ADD CONSTRAINT uq_commerce_merchants_tenant_id UNIQUE (tenant_id, id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_commerce_merchants_tenant
  ON commerce_merchants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commerce_merchants_environment
  ON commerce_merchants(environment);
CREATE INDEX IF NOT EXISTS idx_commerce_merchants_disabled
  ON commerce_merchants(disabled_at) WHERE disabled_at IS NOT NULL;
