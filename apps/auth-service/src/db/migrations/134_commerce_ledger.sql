-- SPDX-License-Identifier: Apache-2.0
-- Commerce ledger (G16).
--
-- 1. commerce_arbiter_decisions: every decision AgenticOrg's policy arbiter
--    seals, append-only, keyed by its decision_id. An allow carries the
--    claims of the machine-profile decision grant countersigning it
--    (spec/decision-grant.md section 10); a refusal carries none.
--
-- Every statement is idempotent: the migration ledger may run a file again
-- on a database that predates the ledger.

CREATE TABLE IF NOT EXISTS commerce_arbiter_decisions (
  decision_id      TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  merchant_id      TEXT NOT NULL,
  seller_agent_id  TEXT NOT NULL,
  buyer_agent_id   TEXT NOT NULL,
  action           TEXT NOT NULL,
  action_hash      TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  rules_evaluated  JSONB NOT NULL,
  failing_rule     TEXT,
  evidence         JSONB NOT NULL,
  decided_at       TIMESTAMPTZ NOT NULL,
  policy_version   TEXT NOT NULL,
  -- Lowercase hex SHA-256 of the RFC 8785 form of the posted decision: the
  -- same decision_id with another body is refused (409).
  request_hash     TEXT NOT NULL,
  grant_jti        TEXT UNIQUE,
  grant_claims     JSONB,
  grant_expires_at TIMESTAMPTZ,
  service_id       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_arbiter_outcome CHECK (outcome IN ('allow', 'refuse')),
  CONSTRAINT chk_arbiter_action_hash CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_arbiter_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- A refusal names its failing rule; an allow names none.
  CONSTRAINT chk_arbiter_failing_rule CHECK ((outcome = 'refuse') = (failing_rule IS NOT NULL)),
  -- A grant exists for an allow and never for a refusal: a token is a permission.
  CONSTRAINT chk_arbiter_grant CHECK (
    (outcome = 'allow') = (grant_jti IS NOT NULL)
    AND (grant_jti IS NULL) = (grant_claims IS NULL)
    AND (grant_jti IS NULL) = (grant_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_arbiter_decisions_tenant
  ON commerce_arbiter_decisions(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_commerce_arbiter_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce_arbiter_decisions is append-only';
END
$$;

DROP TRIGGER IF EXISTS trg_commerce_arbiter_decisions_no_update_delete ON commerce_arbiter_decisions;
CREATE TRIGGER trg_commerce_arbiter_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON commerce_arbiter_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_arbiter_decision_mutation();

DROP TRIGGER IF EXISTS trg_commerce_arbiter_decisions_no_truncate ON commerce_arbiter_decisions;
CREATE TRIGGER trg_commerce_arbiter_decisions_no_truncate
  BEFORE TRUNCATE ON commerce_arbiter_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_commerce_arbiter_decision_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON commerce_arbiter_decisions TO grantex_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_arbiter_decisions FROM grantex_app';
  END IF;
END
$$;
