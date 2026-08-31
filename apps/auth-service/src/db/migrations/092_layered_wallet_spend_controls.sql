-- Layered, reservation-aware spend governance for agent prepaid wallets.
-- Grantex owns semantic and cross-wallet policy. Issuer/custody providers
-- remain authoritative for network authorization, regulated custody, clearing,
-- refunds, reversals, disputes, and chargebacks.

ALTER TABLE agent_wallet_assignments
  ADD COLUMN IF NOT EXISTS budget_group TEXT,
  ADD COLUMN IF NOT EXISTS allowed_resource_origins TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS allow_any_recipient BOOLEAN,
  ADD COLUMN IF NOT EXISTS allow_any_scope BOOLEAN,
  ADD COLUMN IF NOT EXISTS allow_any_resource BOOLEAN;

-- Preserve the explicit behavior of assignments created before this migration.
-- New assignments default-deny unless an unrestricted dimension is selected.
UPDATE agent_wallet_assignments
SET allow_any_recipient = (cardinality(allowed_recipients) = 0)
WHERE allow_any_recipient IS NULL;
UPDATE agent_wallet_assignments
SET allow_any_scope = (cardinality(allowed_scopes) = 0)
WHERE allow_any_scope IS NULL;
UPDATE agent_wallet_assignments
SET allow_any_resource = TRUE
WHERE allow_any_resource IS NULL;

ALTER TABLE agent_wallet_assignments
  ALTER COLUMN allow_any_recipient SET DEFAULT FALSE,
  ALTER COLUMN allow_any_recipient SET NOT NULL,
  ALTER COLUMN allow_any_scope SET DEFAULT FALSE,
  ALTER COLUMN allow_any_scope SET NOT NULL,
  ALTER COLUMN allow_any_resource SET DEFAULT FALSE,
  ALTER COLUMN allow_any_resource SET NOT NULL;

ALTER TABLE prepaid_wallets
  ADD COLUMN IF NOT EXISTS max_balance NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS max_reload_amount NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS reload_cumulative_limit NUMERIC(78,0),
  ADD COLUMN IF NOT EXISTS reload_period_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS reload_count_limit INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_prepaid_wallet_reload_controls') THEN
    ALTER TABLE prepaid_wallets ADD CONSTRAINT chk_prepaid_wallet_reload_controls CHECK (
      (max_balance IS NULL OR max_balance > 0)
      AND (max_reload_amount IS NULL OR max_reload_amount > 0)
      AND (reload_cumulative_limit IS NULL OR reload_cumulative_limit > 0)
      AND (reload_period_seconds IS NULL OR reload_period_seconds BETWEEN 60 AND 31536000)
      AND (reload_count_limit IS NULL OR reload_count_limit > 0)
      AND ((reload_cumulative_limit IS NULL AND reload_count_limit IS NULL)
        OR reload_period_seconds IS NOT NULL)
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wallet_spend_policies (
  id                    TEXT PRIMARY KEY,
  developer_id          TEXT NOT NULL REFERENCES developers(id),
  principal_id          TEXT,
  name                  TEXT NOT NULL,
  description           TEXT,
  scope_type            TEXT NOT NULL,
  scope_id              TEXT,
  effect                TEXT NOT NULL,
  on_exceed             TEXT NOT NULL DEFAULT 'deny',
  max_amount            NUMERIC(78,0),
  max_count             INTEGER,
  window_type           TEXT NOT NULL DEFAULT 'per_authorization',
  window_seconds        INTEGER,
  recipients            TEXT[] NOT NULL DEFAULT '{}',
  resource_origins      TEXT[] NOT NULL DEFAULT '{}',
  action_scopes         TEXT[] NOT NULL DEFAULT '{}',
  assets                TEXT[] NOT NULL DEFAULT '{}',
  networks              TEXT[] NOT NULL DEFAULT '{}',
  merchant_ids          TEXT[] NOT NULL DEFAULT '{}',
  purposes              TEXT[] NOT NULL DEFAULT '{}',
  project_ids           TEXT[] NOT NULL DEFAULT '{}',
  cost_centers          TEXT[] NOT NULL DEFAULT '{}',
  require_verified_merchant BOOLEAN NOT NULL DEFAULT FALSE,
  priority              INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  version               INTEGER NOT NULL DEFAULT 1,
  valid_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_spend_policy_scope CHECK (
    scope_type IN ('assignment','wallet','agent','group','principal','developer')
  ),
  CONSTRAINT chk_wallet_spend_policy_effect CHECK (
    effect IN ('limit','deny','require_approval')
  ),
  CONSTRAINT chk_wallet_spend_policy_on_exceed CHECK (
    on_exceed IN ('deny','require_approval')
  ),
  CONSTRAINT chk_wallet_spend_policy_window CHECK (
    window_type IN ('per_authorization','rolling','calendar_day','calendar_week','calendar_month','lifetime')
    AND (window_type <> 'rolling' OR window_seconds BETWEEN 10 AND 2678400)
  ),
  CONSTRAINT chk_wallet_spend_policy_limits CHECK (
    (effect <> 'limit') OR (max_amount IS NOT NULL OR max_count IS NOT NULL)
  ),
  CONSTRAINT chk_wallet_spend_policy_values CHECK (
    (max_amount IS NULL OR max_amount >= 0)
    AND (max_count IS NULL OR max_count >= 0)
    AND priority BETWEEN -100000 AND 100000
    AND version > 0
    AND (valid_until IS NULL OR valid_until > valid_from)
  )
);

CREATE INDEX IF NOT EXISTS idx_wallet_spend_policies_owner
  ON wallet_spend_policies(developer_id, principal_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_spend_policies_scope
  ON wallet_spend_policies(developer_id, scope_type, scope_id)
  WHERE status = 'active';

ALTER TABLE wallet_payment_reservations
  ADD COLUMN IF NOT EXISTS merchant_id TEXT,
  ADD COLUMN IF NOT EXISTS purpose TEXT,
  ADD COLUMN IF NOT EXISTS project_id TEXT,
  ADD COLUMN IF NOT EXISTS cost_center TEXT,
  ADD COLUMN IF NOT EXISTS resource_origin TEXT,
  ADD COLUMN IF NOT EXISTS policy_decision_id TEXT;

-- Reservation resources have always been validated as absolute HTTP(S) URLs.
-- Persist the normalized origin so resource-scoped cumulative policies account
-- only for historical payments in the same policy dimension.
UPDATE wallet_payment_reservations
SET resource_origin = CASE
  WHEN lower(resource) LIKE 'https://%'
    THEN regexp_replace(lower(substring(resource FROM '(?i)^https?://[^/?#]+')), ':443$', '')
  WHEN lower(resource) LIKE 'http://%'
    THEN regexp_replace(lower(substring(resource FROM '(?i)^https?://[^/?#]+')), ':80$', '')
  ELSE lower(substring(resource FROM '(?i)^https?://[^/?#]+'))
END
WHERE resource_origin IS NULL;

CREATE TABLE IF NOT EXISTS wallet_payment_approval_requests (
  id                    TEXT PRIMARY KEY,
  developer_id          TEXT NOT NULL REFERENCES developers(id),
  principal_id          TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id),
  grant_id              TEXT NOT NULL REFERENCES grants(id),
  wallet_id             TEXT NOT NULL REFERENCES prepaid_wallets(id),
  assignment_id         TEXT NOT NULL REFERENCES agent_wallet_assignments(id),
  request_hash          TEXT NOT NULL,
  amount                NUMERIC(78,0) NOT NULL,
  asset                 TEXT NOT NULL,
  network               TEXT NOT NULL,
  recipient             TEXT NOT NULL,
  resource              TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  merchant_id           TEXT,
  purpose               TEXT,
  project_id            TEXT,
  cost_center           TEXT,
  policy_ids            TEXT[] NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  reason                TEXT,
  expires_at            TIMESTAMPTZ NOT NULL,
  decided_at            TIMESTAMPTZ,
  consumed_at           TIMESTAMPTZ,
  reservation_id        TEXT REFERENCES wallet_payment_reservations(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_payment_approval_status CHECK (
    status IN ('pending','approved','rejected','consumed','expired')
  ),
  CONSTRAINT chk_wallet_payment_approval_amount CHECK (amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_payment_approval_active_request
  ON wallet_payment_approval_requests(developer_id, principal_id, agent_id, request_hash)
  WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS idx_wallet_payment_approval_principal
  ON wallet_payment_approval_requests(developer_id, principal_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_policy_decisions (
  id                    TEXT PRIMARY KEY,
  developer_id          TEXT NOT NULL REFERENCES developers(id),
  principal_id          TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id),
  wallet_id             TEXT NOT NULL REFERENCES prepaid_wallets(id),
  assignment_id         TEXT NOT NULL REFERENCES agent_wallet_assignments(id),
  reservation_id        TEXT REFERENCES wallet_payment_reservations(id),
  approval_request_id   TEXT REFERENCES wallet_payment_approval_requests(id),
  request_hash          TEXT NOT NULL,
  decision              TEXT NOT NULL,
  matched_policy_ids    TEXT[] NOT NULL DEFAULT '{}',
  evaluations           JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_policy_decision CHECK (
    decision IN ('allowed','denied','approval_required')
  )
);

CREATE INDEX IF NOT EXISTS idx_wallet_policy_decisions_principal
  ON wallet_policy_decisions(developer_id, principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_policy_decisions_agent
  ON wallet_policy_decisions(developer_id, agent_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_wallet_policy_decision_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'wallet policy decisions are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wallet_policy_decisions_append_only ON wallet_policy_decisions;
CREATE TRIGGER trg_wallet_policy_decisions_append_only
  BEFORE UPDATE OR DELETE ON wallet_policy_decisions
  FOR EACH ROW EXECUTE FUNCTION prevent_wallet_policy_decision_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON wallet_policy_decisions FROM grantex_app;
  END IF;
END $$;
