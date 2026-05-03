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
  CONSTRAINT chk_merchants_environment CHECK (environment IN ('sandbox','live'))
);

-- Spec §15 mandates (tenant_id, id) unique even though id is already PK.
-- Carrying the redundant constraint matches the spec text and makes
-- composite FKs from cross-tenant tables straightforward later.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_merchants_tenant_id
  ON commerce_merchants(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_commerce_merchants_tenant
  ON commerce_merchants(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commerce_merchants_environment
  ON commerce_merchants(environment);
CREATE INDEX IF NOT EXISTS idx_commerce_merchants_disabled
  ON commerce_merchants(disabled_at) WHERE disabled_at IS NOT NULL;
