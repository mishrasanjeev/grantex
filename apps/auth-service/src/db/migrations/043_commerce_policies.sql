-- Grantex Commerce V1 - Milestone 3: CommercePolicy persistence.
-- Policies are versioned per merchant. Creating a policy only creates a
-- draft; activation is explicit and archives the prior active version.

CREATE TABLE IF NOT EXISTS commerce_policies (
  id             TEXT PRIMARY KEY,                                  -- cpol_<ulid>
  tenant_id      TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id    TEXT NOT NULL,
  version        TEXT NOT NULL,
  rules          JSONB NOT NULL,
  status         TEXT NOT NULL DEFAULT 'draft',                     -- draft | active | archived
  created_by     TEXT NOT NULL,
  activated_by   TEXT,
  activated_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commerce_policies_status CHECK (status IN ('draft','active','archived')),
  CONSTRAINT chk_commerce_policies_rules_object CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT fk_commerce_policies_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT uq_commerce_policies_version
    UNIQUE (tenant_id, merchant_id, version)
);

CREATE INDEX IF NOT EXISTS idx_commerce_policies_tenant_merchant_status
  ON commerce_policies(tenant_id, merchant_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_policies_one_active
  ON commerce_policies(tenant_id, merchant_id)
  WHERE status = 'active';

-- Active policy rules and identity fields are immutable. Activation may
-- transition a draft to active, and activating a replacement may transition
-- the old active row to archived, but rules/version/ownership never change
-- once a row has been active.
CREATE OR REPLACE FUNCTION commerce_policies_prevent_active_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'active' THEN
    IF NEW.rules IS DISTINCT FROM OLD.rules
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
       OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'active commerce policies are immutable'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status NOT IN ('active', 'archived') THEN
      RAISE EXCEPTION 'active commerce policies may only transition to archived'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_policies_no_active_mutation ON commerce_policies;
CREATE TRIGGER commerce_policies_no_active_mutation
  BEFORE UPDATE ON commerce_policies
  FOR EACH ROW EXECUTE FUNCTION commerce_policies_prevent_active_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_policies TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_policies FROM grantex_app';
  END IF;
END
$$;

