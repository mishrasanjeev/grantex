-- Grantex Commerce V1 — Milestone 1: category presets.
-- V1 ships exactly one preset: electronics_appliances. preset_key is the
-- stable PK so future FKs from merchants/products use the human-readable
-- key rather than a ULID.

CREATE TABLE IF NOT EXISTS commerce_category_presets (
  preset_key            TEXT PRIMARY KEY,                       -- e.g. electronics_appliances
  display_name          TEXT NOT NULL,
  version               TEXT NOT NULL,                          -- ISO date, e.g. 2026-05-01
  required_fields       JSONB NOT NULL DEFAULT '[]'::JSONB,
  default_policy_rules  JSONB NOT NULL DEFAULT '{}'::JSONB,
  default_capabilities  JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO commerce_category_presets (
  preset_key, display_name, version, required_fields,
  default_policy_rules, default_capabilities
) VALUES (
  'electronics_appliances',
  'Electronics & Appliances',
  '2026-05-01',
  '[
    "sku","title","brand","price_amount","currency","tax_inclusive",
    "gst_slab","hsn_code","availability_status","warranty_summary",
    "return_policy_summary"
  ]'::JSONB,
  '{
    "amount_cap":            { "max_amount_minor_units": 50000000, "currency": "INR" },
    "scope_allowlist":       [
      "commerce:catalog.read","commerce:inventory.read",
      "commerce:checkout.create","commerce:payment.initiate",
      "commerce:payment.status.read"
    ],
    "emergency_disable":              false,
    "checkout_passport_max_ttl_seconds": 600,
    "browse_passport_max_ttl_seconds":   3600,
    "stale_price_max_age_seconds":       86400,
    "allow_unknown_inventory_checkout":  false
  }'::JSONB,
  '[
    "merchant.get_profile","catalog.search","catalog.get_item",
    "inventory.check","cart.create","checkout.create",
    "payment.create_intent","payment.get_status"
  ]'::JSONB
) ON CONFLICT (preset_key) DO NOTHING;
