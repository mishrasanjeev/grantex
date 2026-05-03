-- Grantex Commerce V1 — Milestone 2: merchant server-to-server API keys.
-- Spec §6: `Authorization: Bearer grtx_sk_<environment>_<secret>` keys
-- store only the salted hash. Resolve (tenant_id, merchant_id) from the
-- key record; never trust caller-supplied tenant/merchant for this caller
-- type.
--
-- M2 ships the schema and the auth resolver. Operator endpoints to
-- create/rotate keys are deferred to M3 (will surface POST
-- /v1/commerce/merchants/{id}/api-keys); for M2, keys are seeded via
-- direct SQL during deploy provisioning or via test fixtures.

CREATE TABLE IF NOT EXISTS commerce_merchant_api_keys (
  id            TEXT PRIMARY KEY,                                       -- mkey_<ulid>
  tenant_id     TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id   TEXT NOT NULL,
  environment   TEXT NOT NULL,                                          -- sandbox | live
  key_hash      TEXT NOT NULL,                                          -- sha256 of grtx_sk_<env>_<secret>
  display_name  TEXT,
  created_by    TEXT,                                                   -- developer_id of the operator who created it
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT chk_merchant_api_key_env CHECK (environment IN ('sandbox','live')),
  CONSTRAINT fk_merchant_api_key_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id)
);

-- Lookup by hash; only active (non-revoked) keys must be unique on hash —
-- a revoked key's hash can be left in place for forensic linkage.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_merchant_api_keys_hash
  ON commerce_merchant_api_keys(key_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_merchant_api_keys_merchant
  ON commerce_merchant_api_keys(tenant_id, merchant_id);
