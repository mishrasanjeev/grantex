-- Budget allocations: one per grant
CREATE TABLE IF NOT EXISTS budget_allocations (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE REFERENCES grants(id),
  developer_id TEXT NOT NULL REFERENCES developers(id),
  initial_budget NUMERIC(18, 4) NOT NULL,
  remaining_budget NUMERIC(18, 4) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_allocations_grant ON budget_allocations(grant_id);
CREATE INDEX IF NOT EXISTS idx_budget_allocations_developer ON budget_allocations(developer_id);

-- Budget transactions: debit log
CREATE TABLE IF NOT EXISTS budget_transactions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id),
  allocation_id TEXT NOT NULL REFERENCES budget_allocations(id),
  amount NUMERIC(18, 4) NOT NULL,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_transactions_grant ON budget_transactions(grant_id);
CREATE INDEX IF NOT EXISTS idx_budget_transactions_allocation ON budget_transactions(allocation_id);

-- Optional budget field on auth_requests for budget param on authorize
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS budget NUMERIC(18, 4);
