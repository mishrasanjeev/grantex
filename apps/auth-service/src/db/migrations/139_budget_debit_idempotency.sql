-- Additive replay state only; existing allocations and ledger rows need no backfill.
-- The route uses this table only with BUDGET_DEBIT_IDEMPOTENCY_ENABLED=true.
CREATE TABLE IF NOT EXISTS budget_debit_idempotency (
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  remaining_budget NUMERIC(18, 4) NOT NULL CHECK (remaining_budget >= 0),
  transaction_id TEXT NOT NULL REFERENCES budget_transactions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  PRIMARY KEY (developer_id, grant_id, key_hash),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_budget_debit_idempotency_expiry
  ON budget_debit_idempotency(developer_id, grant_id, expires_at);
