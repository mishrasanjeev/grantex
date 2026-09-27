-- SPDX-License-Identifier: Apache-2.0
-- The emergency stop's lockout. A stop that asks for one (`lockout: true`)
-- records a freeze here before it sweeps, and every issuance path refuses to
-- issue a grant or a token under a freeze that has not been lifted. A stop
-- that does not ask for one never writes here.
--
-- Additive: one new table, created empty, and one column on emergency_stops
-- with a constant default, so existing rows read as what they were — sweeps.
-- Nothing reads or writes either unless EMERGENCY_STOP_ENABLED=true.
--
-- Scopes mirror the stop's own. A freeze is never deleted: lifting it sets
-- cleared_at and cleared_by, so the table is the history of every lockout as
-- well as the current state. `placed_by` says whose it is to lift: a freeze
-- the operator placed cannot be lifted with the tenant's own key.

CREATE TABLE IF NOT EXISTS issuance_freezes (
  id            TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  stop_id       TEXT REFERENCES emergency_stops(id) ON DELETE SET NULL,
  placed_by     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  requested_by  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at    TIMESTAMPTZ,
  cleared_by    TEXT,
  clear_reason  TEXT,
  CONSTRAINT chk_issuance_freezes_scope CHECK (scope_type IN ('grant', 'agent', 'principal', 'developer')),
  CONSTRAINT chk_issuance_freezes_placed_by CHECK (placed_by IN ('developer', 'operator')),
  -- A lifted freeze always says who lifted it.
  CONSTRAINT chk_issuance_freezes_cleared CHECK ((cleared_at IS NULL) = (cleared_by IS NULL))
);

-- At most one freeze in force per scope: a second stop over the same scope
-- reaffirms it rather than stacking another, and lifting it is one row. It is
-- also the index every issuance path reads through.
CREATE UNIQUE INDEX IF NOT EXISTS uq_issuance_freezes_active
  ON issuance_freezes (developer_id, scope_type, scope_id)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_issuance_freezes_developer
  ON issuance_freezes (developer_id, created_at DESC);

-- Whether the stop asked for a lockout. Constant default: no table rewrite.
ALTER TABLE emergency_stops ADD COLUMN IF NOT EXISTS lockout BOOLEAN NOT NULL DEFAULT FALSE;
