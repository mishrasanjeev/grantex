-- Grantex Commerce V1 - Milestone 4B: cart drafts and payment intents.
-- Carts keep immutable line-item snapshots. Payment intents reference both
-- the cart and the snapshot so later catalog price changes never mutate an
-- authorized checkout amount.

CREATE TABLE IF NOT EXISTS commerce_carts (
  id                        TEXT PRIMARY KEY,                         -- ccart_<ulid>
  tenant_id                 TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id               TEXT NOT NULL,
  agent_id                  TEXT NOT NULL,
  passport_jti              TEXT REFERENCES commerce_passports(jti),
  line_items                JSONB NOT NULL,
  line_items_snapshot       JSONB NOT NULL,
  currency                  TEXT NOT NULL,
  subtotal_amount           BIGINT NOT NULL,
  tax_amount                BIGINT NOT NULL DEFAULT 0,
  total_amount              BIGINT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'draft',
  expires_at                TIMESTAMPTZ NOT NULL,
  line_items_snapshot_hash  TEXT NOT NULL,
  idempotency_key_hash      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commerce_carts_status
    CHECK (status IN ('draft','payment_intent_created','cancelled','expired')),
  CONSTRAINT chk_commerce_carts_amounts
    CHECK (subtotal_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0),
  CONSTRAINT chk_commerce_carts_line_items_array
    CHECK (jsonb_typeof(line_items) = 'array' AND jsonb_typeof(line_items_snapshot) = 'array'),
  CONSTRAINT fk_commerce_carts_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_commerce_carts_agent
    FOREIGN KEY (tenant_id, agent_id)
    REFERENCES commerce_agents(tenant_id, id),
  CONSTRAINT uq_commerce_carts_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_carts_tenant_merchant_created
  ON commerce_carts(tenant_id, merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_carts_agent
  ON commerce_carts(tenant_id, agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_payment_intents (
  id                    TEXT PRIMARY KEY,                             -- cpi_<ulid>
  tenant_id             TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id           TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  cart_id               TEXT NOT NULL,
  passport_jti          TEXT NOT NULL REFERENCES commerce_passports(jti),
  amount                BIGINT NOT NULL,
  currency              TEXT NOT NULL,
  provider              TEXT NOT NULL,
  provider_environment  TEXT NOT NULL,                                -- sandbox | live
  provider_payment_id   TEXT,
  provider_order_id     TEXT,
  checkout_url          TEXT,
  status                TEXT NOT NULL,
  line_items_snapshot   JSONB NOT NULL,
  idempotency_key_hash  TEXT NOT NULL,
  provider_metadata     JSONB NOT NULL DEFAULT '{}'::JSONB,
  provider_raw_status   TEXT,
  policy_version        TEXT,
  decision_id           TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_payment_intents_status CHECK (
    status IN ('created','authorized','checkout_created','payment_pending','paid','failed','cancelled','expired')
  ),
  CONSTRAINT chk_payment_intents_provider_environment CHECK (provider_environment IN ('sandbox','live')),
  CONSTRAINT chk_payment_intents_amount CHECK (amount >= 0),
  CONSTRAINT chk_payment_intents_snapshot_array CHECK (jsonb_typeof(line_items_snapshot) = 'array'),
  CONSTRAINT fk_payment_intents_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_payment_intents_agent
    FOREIGN KEY (tenant_id, agent_id)
    REFERENCES commerce_agents(tenant_id, id),
  CONSTRAINT fk_payment_intents_cart
    FOREIGN KEY (tenant_id, cart_id)
    REFERENCES commerce_carts(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant_merchant_created
  ON commerce_payment_intents(tenant_id, merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_intents_cart
  ON commerce_payment_intents(tenant_id, cart_id);
CREATE INDEX IF NOT EXISTS idx_payment_intents_status
  ON commerce_payment_intents(tenant_id, merchant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_intents_provider_payment
  ON commerce_payment_intents(tenant_id, provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_carts TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_carts FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_payment_intents TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_payment_intents FROM grantex_app';
  END IF;
END
$$;
