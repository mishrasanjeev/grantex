-- Grantex Commerce V1 — Milestone 1: CommerceAuditEvent (append-only).
-- Spec §10 requires database-level append-only enforcement. This migration
-- defends in two layers:
--
--   (1) Trigger-based BEFORE UPDATE/DELETE block — works regardless of which
--       role the application connects as. This is the universally-applicable
--       guarantee and what the test suite verifies.
--
--   (2) Optional GRANT/REVOKE in a DO block — applies if a separate
--       grantex_app role exists in the deployment. No-ops in dev/CI where
--       the application connects as the table owner (owners bypass GRANTs).
--       Production deployments should provision the grantex_app role and
--       re-run this migration to engage layer (2).

CREATE TABLE IF NOT EXISTS commerce_audit_events (
  id                    TEXT PRIMARY KEY,                                       -- caud_<ulid>
  tenant_id             TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id           TEXT REFERENCES commerce_merchants(id),
  agent_id              TEXT REFERENCES commerce_agents(id),
  user_principal_id     TEXT,
  event_type            TEXT NOT NULL,                                          -- e.g. merchant.created, passport.issued
  resource_type         TEXT,
  resource_id           TEXT,
  passport_jti          TEXT,                                                   -- nullable in M1 (no passports yet)
  policy_version        TEXT,
  decision_id           TEXT,
  idempotency_key_hash  TEXT,
  request_id            TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata              JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- Spec §15 required index for tenant-scoped audit listing.
CREATE INDEX IF NOT EXISTS idx_commerce_audit_tenant_merchant_occurred
  ON commerce_audit_events(tenant_id, merchant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_commerce_audit_event_type
  ON commerce_audit_events(event_type);
CREATE INDEX IF NOT EXISTS idx_commerce_audit_passport_jti
  ON commerce_audit_events(passport_jti) WHERE passport_jti IS NOT NULL;

-- Layer (1) — trigger-based append-only enforcement.
CREATE OR REPLACE FUNCTION commerce_audit_events_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'commerce_audit_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_audit_events_no_update ON commerce_audit_events;
CREATE TRIGGER commerce_audit_events_no_update
  BEFORE UPDATE ON commerce_audit_events
  FOR EACH ROW EXECUTE FUNCTION commerce_audit_events_block_mutation();

DROP TRIGGER IF EXISTS commerce_audit_events_no_delete ON commerce_audit_events;
CREATE TRIGGER commerce_audit_events_no_delete
  BEFORE DELETE ON commerce_audit_events
  FOR EACH ROW EXECUTE FUNCTION commerce_audit_events_block_mutation();

-- Layer (2) — role-based grants when a separate app role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_audit_events FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT ON commerce_audit_events TO grantex_app';
  END IF;
END
$$;
