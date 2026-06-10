-- Grantex Commerce C6U8: order handoff contract foundation only.
-- Handoff rows record tenant-scoped, buyer-safe source facts for future
-- fulfillment, delivery, support, return, and refund status handling. They
-- do not execute fulfillment, shipping, refunds, settlement, payout,
-- checkout/payment, provider calls, or merchant private API calls.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'uq_commerce_orders_tenant_order_merchant'
       AND conrelid = 'commerce_orders'::regclass
  ) THEN
    ALTER TABLE commerce_orders
      ADD CONSTRAINT uq_commerce_orders_tenant_order_merchant UNIQUE (tenant_id, id, merchant_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS commerce_order_handoffs (
  id                         TEXT PRIMARY KEY, -- cohf_<ulid>
  tenant_id                  TEXT NOT NULL REFERENCES commerce_tenants(id),
  order_id                   TEXT NOT NULL,
  merchant_id                TEXT NOT NULL,
  buyer_principal_id         TEXT NOT NULL,
  agent_id                   TEXT,
  session_id                 TEXT,
  handoff_type               TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'draft',
  status_reason              TEXT,
  handoff_snapshot           JSONB NOT NULL,
  source_freshness_refs      JSONB NOT NULL DEFAULT '{}'::JSONB,
  support_reference          JSONB NOT NULL DEFAULT '{"state":"handoff_support_not_enabled_by_c6u8"}'::JSONB,
  audit_evidence_refs        JSONB NOT NULL DEFAULT '[]'::JSONB,
  idempotency_scope          TEXT NOT NULL,
  idempotency_key_hash       TEXT NOT NULL,
  created_from               TEXT NOT NULL DEFAULT 'order_safe_source',
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commerce_order_handoff_type CHECK (
    handoff_type IN ('fulfillment','delivery','support','return','refund')
  ),
  CONSTRAINT chk_commerce_order_handoff_status CHECK (
    status IN (
      'draft',
      'requested',
      'acknowledged',
      'blocked',
      'rejected',
      'expired',
      'cancelled',
      'manual_review_required',
      'resolved_manually'
    )
  ),
  CONSTRAINT chk_commerce_order_handoff_created_from CHECK (
    created_from IN ('order_safe_source','merchant_safe_source','operator_record','manual_review')
  ),
  CONSTRAINT chk_commerce_order_handoff_idempotency_scope CHECK (
    idempotency_scope IN (
      'order.handoff.fulfillment.record',
      'order.handoff.delivery.record',
      'order.handoff.support.record',
      'order.handoff.return.record',
      'order.handoff.refund.record'
    )
  ),
  CONSTRAINT chk_commerce_order_handoff_snapshot_object
    CHECK (jsonb_typeof(handoff_snapshot) = 'object'),
  CONSTRAINT chk_commerce_order_handoff_source_refs_object
    CHECK (jsonb_typeof(source_freshness_refs) = 'object'),
  CONSTRAINT chk_commerce_order_handoff_support_reference_object
    CHECK (jsonb_typeof(support_reference) = 'object'),
  CONSTRAINT chk_commerce_order_handoff_audit_refs_array
    CHECK (jsonb_typeof(audit_evidence_refs) = 'array'),
  CONSTRAINT fk_commerce_order_handoff_order
    FOREIGN KEY (tenant_id, order_id, merchant_id)
    REFERENCES commerce_orders(tenant_id, id, merchant_id),
  CONSTRAINT fk_commerce_order_handoff_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_commerce_order_handoff_agent
    FOREIGN KEY (tenant_id, agent_id)
    REFERENCES commerce_agents(tenant_id, id),
  CONSTRAINT uq_commerce_order_handoffs_tenant_id UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_order_handoffs_idempotency
  ON commerce_order_handoffs(tenant_id, order_id, handoff_type, idempotency_scope, idempotency_key_hash);

CREATE INDEX IF NOT EXISTS idx_commerce_order_handoffs_order_type
  ON commerce_order_handoffs(tenant_id, order_id, handoff_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_order_handoffs_merchant_status
  ON commerce_order_handoffs(tenant_id, merchant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_order_handoffs_buyer
  ON commerce_order_handoffs(tenant_id, buyer_principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_order_handoffs_agent_session
  ON commerce_order_handoffs(tenant_id, agent_id, session_id)
  WHERE agent_id IS NOT NULL OR session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION commerce_order_handoffs_block_immutable_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.buyer_principal_id IS DISTINCT FROM OLD.buyer_principal_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.handoff_type IS DISTINCT FROM OLD.handoff_type
     OR NEW.handoff_snapshot IS DISTINCT FROM OLD.handoff_snapshot
     OR NEW.source_freshness_refs IS DISTINCT FROM OLD.source_freshness_refs
     OR NEW.audit_evidence_refs IS DISTINCT FROM OLD.audit_evidence_refs
     OR NEW.idempotency_scope IS DISTINCT FROM OLD.idempotency_scope
     OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
     OR NEW.created_from IS DISTINCT FROM OLD.created_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'commerce_order_handoffs immutable fields cannot be changed'
      USING ERRCODE = 'invalid_column_reference';
  END IF;
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_order_handoffs_immutable_fields ON commerce_order_handoffs;
CREATE TRIGGER commerce_order_handoffs_immutable_fields
  BEFORE UPDATE ON commerce_order_handoffs
  FOR EACH ROW EXECUTE FUNCTION commerce_order_handoffs_block_immutable_update();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_order_handoffs TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_order_handoffs FROM grantex_app';
  END IF;
END
$$;
