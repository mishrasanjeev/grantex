-- Grantex Commerce V1 — Milestone 2: Commerce Passport storage.
-- Spec §15. Passports are append-only (BEFORE UPDATE/DELETE trigger);
-- revocation lives in a sibling commerce_passport_revocations table so
-- the passport row itself stays immutable forensic evidence.
--
-- jti is globally unique (spec §15). FK to commerce_passport_keys(kid)
-- pins which key signed this passport — required for the rotation grace
-- window logic (a retired key's passports stay verifiable until they
-- naturally expire).

CREATE TABLE IF NOT EXISTS commerce_passports (
  jti                 TEXT PRIMARY KEY,                                       -- globally unique
  tenant_id           TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id         TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  consent_record_id   TEXT NOT NULL UNIQUE REFERENCES commerce_consent_records(id),
  passport_type       TEXT NOT NULL,                                          -- browse | checkout
  kid                 TEXT NOT NULL REFERENCES commerce_passport_keys(kid),
  subject             TEXT NOT NULL,                                          -- user_principal_id
  scopes              TEXT[] NOT NULL,
  max_amount          BIGINT,
  currency            TEXT,
  policy_version      TEXT,                                                   -- nullable; M3 lands policy
  environment         TEXT NOT NULL,                                          -- sandbox | live
  audience            TEXT,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_before          TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  agent_auth_method   TEXT NOT NULL,                                          -- jwt | api_key
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_passport_type CHECK (passport_type IN ('browse','checkout')),
  CONSTRAINT chk_passport_environment CHECK (environment IN ('sandbox','live')),
  CONSTRAINT chk_passport_agent_auth_method CHECK (agent_auth_method IN ('jwt','api_key')),
  CONSTRAINT fk_passport_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_passport_agent
    FOREIGN KEY (tenant_id, agent_id)
    REFERENCES commerce_agents(tenant_id, id)
);

-- Belt-and-braces: when an older deployment applied this migration before
-- the UNIQUE was added inline, add the constraint via ALTER. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'commerce_passports_consent_record_id_key'
       AND conrelid = 'commerce_passports'::regclass
  ) THEN
    BEGIN
      ALTER TABLE commerce_passports
        ADD CONSTRAINT commerce_passports_consent_record_id_key
        UNIQUE (consent_record_id);
    EXCEPTION WHEN duplicate_table OR duplicate_object THEN
      -- Constraint exists under a different name; tolerate.
      NULL;
    END;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_commerce_passports_tenant_merchant_agent_exp
  ON commerce_passports(tenant_id, merchant_id, agent_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_commerce_passports_consent_record
  ON commerce_passports(consent_record_id);

-- Append-only enforcement (mirror of commerce_audit_events from M1).
CREATE OR REPLACE FUNCTION commerce_passports_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'commerce_passports is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_passports_no_update ON commerce_passports;
CREATE TRIGGER commerce_passports_no_update
  BEFORE UPDATE ON commerce_passports
  FOR EACH ROW EXECUTE FUNCTION commerce_passports_block_mutation();

DROP TRIGGER IF EXISTS commerce_passports_no_delete ON commerce_passports;
CREATE TRIGGER commerce_passports_no_delete
  BEFORE DELETE ON commerce_passports
  FOR EACH ROW EXECUTE FUNCTION commerce_passports_block_mutation();

CREATE TABLE IF NOT EXISTS commerce_passport_revocations (
  jti           TEXT PRIMARY KEY REFERENCES commerce_passports(jti),
  tenant_id     TEXT NOT NULL REFERENCES commerce_tenants(id),
  reason        TEXT NOT NULL,                                                -- explicit | user_revoked | merchant_disabled | agent_disabled | tenant_disabled | scope_violation
  revoked_by    TEXT,                                                         -- caller identifier (operator id / merchant key id / agent id / 'system')
  revoked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_passport_revocations_tenant
  ON commerce_passport_revocations(tenant_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    -- Mirror the audit append-only grant model on the passport table.
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_passports FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT ON commerce_passports TO grantex_app';
    -- Revocations are append-only at the app layer (no UPDATE path
    -- exposed in the lib); REVOKE for defense in depth.
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_passport_revocations FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT ON commerce_passport_revocations TO grantex_app';
  END IF;
END
$$;
