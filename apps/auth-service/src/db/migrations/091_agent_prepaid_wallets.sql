-- Agent prepaid wallets: durable policy, reservations, reload approvals, and ledger.

CREATE TABLE IF NOT EXISTS prepaid_wallets (
  id                    TEXT PRIMARY KEY,
  developer_id          TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  principal_id          TEXT NOT NULL,
  name                  TEXT NOT NULL,
  custody_mode          TEXT NOT NULL,
  provider              TEXT,
  provider_wallet_id    TEXT,
  wallet_address        TEXT,
  network               TEXT NOT NULL,
  asset                 TEXT NOT NULL,
  decimals              INTEGER NOT NULL DEFAULT 6,
  available_amount      NUMERIC(78,0) NOT NULL DEFAULT 0,
  reserved_amount       NUMERIC(78,0) NOT NULL DEFAULT 0,
  low_balance_threshold NUMERIC(78,0) NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'active',
  blocked_at            TIMESTAMPTZ,
  blocked_reason        TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_prepaid_wallet_custody
    CHECK (custody_mode IN ('sandbox_ledger', 'external')),
  CONSTRAINT chk_prepaid_wallet_status
    CHECK (status IN ('active', 'blocked', 'closed')),
  CONSTRAINT chk_prepaid_wallet_amounts
    CHECK (available_amount >= 0 AND reserved_amount >= 0 AND low_balance_threshold >= 0),
  CONSTRAINT chk_prepaid_wallet_decimals
    CHECK (decimals BETWEEN 0 AND 30),
  CONSTRAINT chk_prepaid_wallet_external_ref
    CHECK (custody_mode = 'sandbox_ledger' OR (provider IS NOT NULL AND provider_wallet_id IS NOT NULL))
);

-- Only external provider references are unique. Treating NULLs as equal here
-- would accidentally restrict each developer to a single sandbox wallet.
ALTER TABLE prepaid_wallets DROP CONSTRAINT IF EXISTS uq_prepaid_wallet_provider_ref;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prepaid_wallet_provider_ref
  ON prepaid_wallets(developer_id, provider, provider_wallet_id)
  WHERE custody_mode = 'external';

CREATE INDEX IF NOT EXISTS idx_prepaid_wallet_principal
  ON prepaid_wallets(developer_id, principal_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_wallet_controls (
  developer_id       TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  principal_id       TEXT NOT NULL,
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  all_wallets_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_at         TIMESTAMPTZ,
  blocked_reason     TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, principal_id, agent_id)
);

CREATE TABLE IF NOT EXISTS agent_wallet_assignments (
  id                        TEXT PRIMARY KEY,
  wallet_id                 TEXT NOT NULL REFERENCES prepaid_wallets(id) ON DELETE CASCADE,
  developer_id              TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  principal_id              TEXT NOT NULL,
  agent_id                  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL DEFAULT 'active',
  per_transaction_limit     NUMERIC(78,0) NOT NULL,
  cumulative_limit          NUMERIC(78,0) NOT NULL,
  cumulative_period_seconds INTEGER NOT NULL,
  allowed_recipients        TEXT[] NOT NULL DEFAULT '{}',
  allowed_scopes            TEXT[] NOT NULL DEFAULT '{}',
  valid_from                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until               TIMESTAMPTZ,
  blocked_at                TIMESTAMPTZ,
  blocked_reason            TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agent_wallet_assignment_status
    CHECK (status IN ('active', 'blocked', 'revoked')),
  CONSTRAINT chk_agent_wallet_assignment_limits
    CHECK (per_transaction_limit > 0 AND cumulative_limit > 0
      AND per_transaction_limit <= cumulative_limit),
  CONSTRAINT chk_agent_wallet_assignment_period
    CHECK (cumulative_period_seconds BETWEEN 60 AND 2592000),
  CONSTRAINT chk_agent_wallet_assignment_validity
    CHECK (valid_until IS NULL OR valid_until > valid_from),
  CONSTRAINT uq_agent_wallet_assignment
    UNIQUE (wallet_id, principal_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_wallet_assignment_agent
  ON agent_wallet_assignments(developer_id, principal_id, agent_id, status);

CREATE TABLE IF NOT EXISTS wallet_payment_reservations (
  id                    TEXT PRIMARY KEY,
  wallet_id             TEXT NOT NULL REFERENCES prepaid_wallets(id),
  assignment_id         TEXT NOT NULL REFERENCES agent_wallet_assignments(id),
  developer_id          TEXT NOT NULL REFERENCES developers(id),
  principal_id          TEXT NOT NULL,
  agent_id              TEXT NOT NULL REFERENCES agents(id),
  grant_id              TEXT NOT NULL REFERENCES grants(id),
  access_token_jti      TEXT NOT NULL,
  authorization_jti     TEXT NOT NULL UNIQUE,
  idempotency_key_hash  TEXT NOT NULL,
  request_hash          TEXT NOT NULL,
  amount                NUMERIC(78,0) NOT NULL,
  asset                 TEXT NOT NULL,
  network               TEXT NOT NULL,
  recipient             TEXT NOT NULL,
  resource              TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'reserved',
  transaction_id        TEXT UNIQUE,
  expires_at            TIMESTAMPTZ NOT NULL,
  settled_at            TIMESTAMPTZ,
  released_at           TIMESTAMPTZ,
  release_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_reservation_amount CHECK (amount > 0),
  CONSTRAINT chk_wallet_reservation_status
    CHECK (status IN ('reserved', 'settled', 'released', 'expired'))
);

-- An agent retry must resolve to the same reservation even when wallet
-- selection was automatic. Per-assignment uniqueness permits wallet drift.
ALTER TABLE wallet_payment_reservations
  DROP CONSTRAINT IF EXISTS uq_wallet_reservation_idempotency;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_reservation_idempotency
  ON wallet_payment_reservations(developer_id, principal_id, agent_id, idempotency_key_hash);

CREATE INDEX IF NOT EXISTS idx_wallet_reservation_window
  ON wallet_payment_reservations(assignment_id, created_at DESC)
  WHERE status IN ('reserved', 'settled');
CREATE INDEX IF NOT EXISTS idx_wallet_reservation_expiry
  ON wallet_payment_reservations(wallet_id, expires_at)
  WHERE status = 'reserved';

CREATE TABLE IF NOT EXISTS wallet_reload_requests (
  id                 TEXT PRIMARY KEY,
  wallet_id          TEXT NOT NULL REFERENCES prepaid_wallets(id) ON DELETE CASCADE,
  assignment_id      TEXT REFERENCES agent_wallet_assignments(id) ON DELETE SET NULL,
  developer_id       TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  principal_id       TEXT NOT NULL,
  agent_id           TEXT REFERENCES agents(id) ON DELETE SET NULL,
  amount             NUMERIC(78,0) NOT NULL,
  reason             TEXT,
  status             TEXT NOT NULL DEFAULT 'pending',
  requested_by       TEXT NOT NULL,
  decided_at         TIMESTAMPTZ,
  funded_at          TIMESTAMPTZ,
  external_reference TEXT,
  idempotency_key_hash TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_reload_amount CHECK (amount > 0),
  CONSTRAINT chk_wallet_reload_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'funded')),
  CONSTRAINT chk_wallet_reload_requester CHECK (requested_by IN ('agent', 'principal'))
);

ALTER TABLE wallet_reload_requests
  ADD COLUMN IF NOT EXISTS idempotency_key_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_pending_agent_reload
  ON wallet_reload_requests(wallet_id, agent_id)
  WHERE status = 'pending' AND agent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_reload_external_reference
  ON wallet_reload_requests(wallet_id, external_reference)
  WHERE external_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_principal_reload_idempotency
  ON wallet_reload_requests(developer_id, principal_id, idempotency_key_hash)
  WHERE requested_by = 'principal' AND idempotency_key_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_agent_reload_idempotency
  ON wallet_reload_requests(developer_id, principal_id, agent_id, idempotency_key_hash)
  WHERE requested_by = 'agent' AND agent_id IS NOT NULL AND idempotency_key_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS wallet_ledger_entries (
  id                 TEXT PRIMARY KEY,
  wallet_id          TEXT NOT NULL REFERENCES prepaid_wallets(id),
  developer_id       TEXT NOT NULL REFERENCES developers(id),
  principal_id       TEXT NOT NULL,
  entry_type         TEXT NOT NULL,
  amount             NUMERIC(78,0) NOT NULL,
  available_after    NUMERIC(78,0) NOT NULL,
  reserved_after     NUMERIC(78,0) NOT NULL,
  reservation_id     TEXT REFERENCES wallet_payment_reservations(id),
  reload_request_id  TEXT REFERENCES wallet_reload_requests(id),
  external_reference TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_wallet_ledger_type
    CHECK (entry_type IN ('credit', 'settlement', 'release', 'expiry_release')),
  CONSTRAINT chk_wallet_ledger_amount CHECK (amount > 0),
  CONSTRAINT chk_wallet_ledger_balances CHECK (available_after >= 0 AND reserved_after >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet
  ON wallet_ledger_entries(wallet_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_wallet_ledger_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wallet_ledger_entries is append-only';
END
$$;

DROP TRIGGER IF EXISTS trg_wallet_ledger_no_update_delete ON wallet_ledger_entries;
CREATE TRIGGER trg_wallet_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION reject_wallet_ledger_mutation();

DROP TRIGGER IF EXISTS trg_wallet_ledger_no_truncate ON wallet_ledger_entries;
CREATE TRIGGER trg_wallet_ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wallet_ledger_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON prepaid_wallets TO grantex_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON agent_wallet_controls TO grantex_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON agent_wallet_assignments TO grantex_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON wallet_payment_reservations TO grantex_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON wallet_reload_requests TO grantex_app';
    EXECUTE 'GRANT SELECT, INSERT ON wallet_ledger_entries TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON prepaid_wallets, agent_wallet_controls, agent_wallet_assignments, wallet_payment_reservations, wallet_reload_requests, wallet_ledger_entries FROM grantex_app';
  END IF;
END
$$;
