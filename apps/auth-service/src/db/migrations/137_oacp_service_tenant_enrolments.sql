-- SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
-- OACP service-tenant enrolment.
--
-- Additive: two new tables, created empty.
--
-- Until now a tenant could use the AgenticOrg internal service token only
-- when an operator listed it in COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS and
-- redeployed. AgenticOrg now enrols a tenant itself
-- (POST /v1/commerce/oacp/service-tenants, scope oacp.service_tenants.enrol)
-- when a merchant connects a catalogue, and the platform admin can revoke the
-- enrolment. A tenant is allowed when it is on the env list (now a bootstrap
-- list) or has an active enrolment here.
--
-- 1. oacp_service_tenant_enrolments: one row per AgenticOrg tenant (its UUID).
--    merchant_ids and source_systems only grow while the enrolment is active:
--    each enrolment call adds its merchant and catalogue source. A service
--    caller acting for an enrolled tenant must name one of its merchants.
--    A revoked row keeps its arrays, so a re-enrolment by the platform admin
--    restores exactly what was enrolled before.
--
-- 2. oacp_service_tenant_enrolment_events: the append-only trail of every
--    enrolment, refusal, revocation and admin read. It is its own table
--    because commerce_audit_events references commerce_tenants, and an
--    AgenticOrg tenant UUID is not a commerce tenant. Updates and deletes are
--    blocked by trigger, as for commerce_audit_events.
--
-- Every statement is idempotent: the migration ledger may run a file again
-- on a database that predates the ledger.

CREATE TABLE IF NOT EXISTS oacp_service_tenant_enrolments (
  tenant_id       UUID PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'active',
  merchant_ids    TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  source_systems  TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  evidence_ref    TEXT,
  enrolled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT,
  CONSTRAINT chk_oacp_service_tenant_status CHECK (status IN ('active', 'revoked')),
  CONSTRAINT chk_oacp_service_tenant_revoked_at CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT chk_oacp_service_tenant_sources
    CHECK (source_systems <@ ARRAY['shopify', 'catalog_upload']::TEXT[]),
  CONSTRAINT chk_oacp_service_tenant_merchants CHECK (cardinality(merchant_ids) BETWEEN 1 AND 1000)
);

COMMENT ON TABLE oacp_service_tenant_enrolments IS
  'AgenticOrg tenants enrolled for the OACP internal service token. Allowed = on COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS or status active here.';
COMMENT ON COLUMN oacp_service_tenant_enrolments.merchant_ids IS
  'Merchants a service caller may name for this tenant; grows by union on each enrolment.';
COMMENT ON COLUMN oacp_service_tenant_enrolments.source_systems IS
  'Catalogue sources enrolled (shopify, catalog_upload); catalog_upload issuance needs it here.';
COMMENT ON COLUMN oacp_service_tenant_enrolments.evidence_ref IS
  'Opaque reference to the merchant onboarding evidence held by AgenticOrg; never the evidence itself.';

-- The admin view lists active or revoked tenants, newest first.
CREATE INDEX IF NOT EXISTS idx_oacp_service_tenant_enrolments_status
  ON oacp_service_tenant_enrolments (status, updated_at DESC);
-- Which tenant enrolled a merchant (operations, incident response).
CREATE INDEX IF NOT EXISTS idx_oacp_service_tenant_enrolments_merchants
  ON oacp_service_tenant_enrolments USING GIN (merchant_ids);

CREATE TABLE IF NOT EXISTS oacp_service_tenant_enrolment_events (
  id             TEXT PRIMARY KEY,                     -- osten_<ulid>
  tenant_id      UUID NOT NULL,
  event_type     TEXT NOT NULL,
  actor          TEXT NOT NULL,                        -- service:<service id> | platform_admin | developer:<id>
  merchant_id    TEXT,
  source_system  TEXT,
  request_id     TEXT,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata       JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT chk_oacp_service_tenant_event_type CHECK (event_type IN (
    'oacp.service_tenant.enrolled',
    'oacp.service_tenant.reactivated',
    'oacp.service_tenant.enrolment_refused',
    'oacp.service_tenant.revoked',
    'oacp.service_tenant.read'
  ))
);

COMMENT ON TABLE oacp_service_tenant_enrolment_events IS
  'Append-only audit trail of OACP service-tenant enrolment, refusal, revocation and admin reads.';

CREATE INDEX IF NOT EXISTS idx_oacp_service_tenant_events_tenant
  ON oacp_service_tenant_enrolment_events (tenant_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION oacp_service_tenant_events_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'oacp_service_tenant_enrolment_events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS oacp_service_tenant_events_no_update ON oacp_service_tenant_enrolment_events;
CREATE TRIGGER oacp_service_tenant_events_no_update
  BEFORE UPDATE ON oacp_service_tenant_enrolment_events
  FOR EACH ROW EXECUTE FUNCTION oacp_service_tenant_events_block_mutation();

DROP TRIGGER IF EXISTS oacp_service_tenant_events_no_delete ON oacp_service_tenant_enrolment_events;
CREATE TRIGGER oacp_service_tenant_events_no_delete
  BEFORE DELETE ON oacp_service_tenant_enrolment_events
  FOR EACH ROW EXECUTE FUNCTION oacp_service_tenant_events_block_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON oacp_service_tenant_enrolment_events FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT ON oacp_service_tenant_enrolment_events TO grantex_app';
  END IF;
END
$$;
