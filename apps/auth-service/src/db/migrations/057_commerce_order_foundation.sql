-- Grantex Commerce C6U7: order foundation only.
-- This table records tenant-scoped order facts derived from Grantex-safe
-- source snapshots. It does not create checkout/payment, call providers,
-- expose public discovery, or execute fulfillment/refunds/support.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'uq_payment_intents_tenant_id'
       AND conrelid = 'commerce_payment_intents'::regclass
  ) THEN
    ALTER TABLE commerce_payment_intents
      ADD CONSTRAINT uq_payment_intents_tenant_id UNIQUE (tenant_id, id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS commerce_orders (
  id                         TEXT PRIMARY KEY, -- cord_<ulid>
  tenant_id                  TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id                TEXT NOT NULL,
  buyer_principal_id         TEXT NOT NULL,
  agent_id                   TEXT,
  cart_id                    TEXT,
  payment_intent_id          TEXT,
  status                     TEXT NOT NULL DEFAULT 'pending_source_facts',
  status_reason              TEXT,
  line_items_snapshot        JSONB NOT NULL,
  commercial_facts_snapshot  JSONB NOT NULL,
  source_freshness_refs      JSONB NOT NULL DEFAULT '{}'::JSONB,
  support_reference          JSONB NOT NULL DEFAULT '{"state":"support_status_not_enabled_by_c6u7"}'::JSONB,
  audit_evidence_refs        JSONB NOT NULL DEFAULT '[]'::JSONB,
  idempotency_scope          TEXT NOT NULL DEFAULT 'order.foundation.record',
  idempotency_key_hash       TEXT NOT NULL,
  created_from               TEXT NOT NULL DEFAULT 'cart_snapshot',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commerce_orders_status CHECK (
    status IN (
      'pending_source_facts',
      'recorded',
      'merchant_acknowledged',
      'closed',
      'cancelled',
      'expired',
      'blocked',
      'unknown'
    )
  ),
  CONSTRAINT chk_commerce_orders_created_from CHECK (
    created_from IN ('cart_snapshot','payment_intent_snapshot','merchant_safe_source','operator_record')
  ),
  CONSTRAINT chk_commerce_orders_line_items_snapshot_array
    CHECK (jsonb_typeof(line_items_snapshot) = 'array'),
  CONSTRAINT chk_commerce_orders_commercial_facts_object
    CHECK (jsonb_typeof(commercial_facts_snapshot) = 'object'),
  CONSTRAINT chk_commerce_orders_source_refs_object
    CHECK (jsonb_typeof(source_freshness_refs) = 'object'),
  CONSTRAINT chk_commerce_orders_support_reference_object
    CHECK (jsonb_typeof(support_reference) = 'object'),
  CONSTRAINT chk_commerce_orders_audit_refs_array
    CHECK (jsonb_typeof(audit_evidence_refs) = 'array'),
  CONSTRAINT fk_commerce_orders_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_commerce_orders_agent
    FOREIGN KEY (tenant_id, agent_id)
    REFERENCES commerce_agents(tenant_id, id),
  CONSTRAINT fk_commerce_orders_cart
    FOREIGN KEY (tenant_id, cart_id)
    REFERENCES commerce_carts(tenant_id, id),
  CONSTRAINT fk_commerce_orders_payment_intent
    FOREIGN KEY (tenant_id, payment_intent_id)
    REFERENCES commerce_payment_intents(tenant_id, id),
  CONSTRAINT uq_commerce_orders_tenant_id UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_orders_idempotency
  ON commerce_orders(tenant_id, merchant_id, idempotency_scope, idempotency_key_hash);

CREATE INDEX IF NOT EXISTS idx_commerce_orders_tenant_merchant_created
  ON commerce_orders(tenant_id, merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_buyer
  ON commerce_orders(tenant_id, buyer_principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_orders_cart
  ON commerce_orders(tenant_id, cart_id)
  WHERE cart_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_orders_payment_intent
  ON commerce_orders(tenant_id, payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_commerce_orders_status
  ON commerce_orders(tenant_id, merchant_id, status);

CREATE OR REPLACE FUNCTION commerce_orders_block_immutable_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.buyer_principal_id IS DISTINCT FROM OLD.buyer_principal_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.cart_id IS DISTINCT FROM OLD.cart_id
     OR NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id
     OR NEW.line_items_snapshot IS DISTINCT FROM OLD.line_items_snapshot
     OR NEW.commercial_facts_snapshot IS DISTINCT FROM OLD.commercial_facts_snapshot
     OR NEW.source_freshness_refs IS DISTINCT FROM OLD.source_freshness_refs
     OR NEW.audit_evidence_refs IS DISTINCT FROM OLD.audit_evidence_refs
     OR NEW.idempotency_scope IS DISTINCT FROM OLD.idempotency_scope
     OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
     OR NEW.created_from IS DISTINCT FROM OLD.created_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'commerce_orders immutable fields cannot be changed'
      USING ERRCODE = 'invalid_column_reference';
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_orders_immutable_fields ON commerce_orders;
CREATE TRIGGER commerce_orders_immutable_fields
  BEFORE UPDATE ON commerce_orders
  FOR EACH ROW EXECUTE FUNCTION commerce_orders_block_immutable_update();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_orders TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_orders FROM grantex_app';
  END IF;
END
$$;
