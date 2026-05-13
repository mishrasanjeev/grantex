-- Grantex Commerce V1 - Milestone 4A: payment foundations.
-- Provider-neutral credential storage and idempotency records only.
-- No payment intent, checkout, or webhook state is introduced here.

CREATE TABLE IF NOT EXISTS commerce_provider_credentials (
  id                     TEXT PRIMARY KEY,                         -- cpc_<ulid>
  tenant_id              TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id            TEXT NOT NULL,
  provider_key           TEXT NOT NULL,                            -- mock | plural | future providers
  environment            TEXT NOT NULL,                            -- sandbox | live
  credential_ref         TEXT NOT NULL,
  encrypted_secret_blob  TEXT NOT NULL,
  secret_version         INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'pending',          -- pending | valid | invalid | disabled
  last_validated_at      TIMESTAMPTZ,
  last_validation_error  JSONB,
  capabilities           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at             TIMESTAMPTZ,
  CONSTRAINT chk_provider_credentials_env CHECK (environment IN ('sandbox','live')),
  CONSTRAINT chk_provider_credentials_status CHECK (status IN ('pending','valid','invalid','disabled')),
  CONSTRAINT fk_provider_credentials_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT uq_provider_credentials_ref
    UNIQUE (tenant_id, merchant_id, provider_key, environment, credential_ref)
);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_merchant
  ON commerce_provider_credentials(tenant_id, merchant_id, provider_key, environment);

CREATE TABLE IF NOT EXISTS commerce_idempotency_records (
  id                    TEXT PRIMARY KEY,                          -- cidm_<ulid>
  tenant_id             TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id           TEXT NOT NULL,
  endpoint              TEXT NOT NULL,
  environment           TEXT NOT NULL,                             -- sandbox | live
  idempotency_key_hash  TEXT NOT NULL,
  request_body_hash     TEXT NOT NULL,
  response_status       INTEGER,
  response_body         JSONB,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_idempotency_env CHECK (environment IN ('sandbox','live')),
  CONSTRAINT fk_idempotency_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT uq_commerce_idempotency_scope
    UNIQUE (tenant_id, merchant_id, endpoint, environment, idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_commerce_idempotency_expires
  ON commerce_idempotency_records(expires_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_provider_credentials TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_provider_credentials FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_idempotency_records TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_idempotency_records FROM grantex_app';
  END IF;
END
$$;
