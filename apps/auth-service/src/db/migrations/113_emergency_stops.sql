-- The emergency stop (PRD G-6): one call that revokes every grant under a
-- grant, an agent, a principal or a whole developer. Additive: one new table
-- recording what each stop covered, created empty. Nothing reads or writes it
-- unless EMERGENCY_STOP_ENABLED=true.
--
-- The revocations themselves are ordinary cascade revocations, so they appear
-- in the audit hash chain and the revocation feed like any other.

CREATE TABLE IF NOT EXISTS emergency_stops (
  id              TEXT PRIMARY KEY,
  developer_id    TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  scope_type      TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  requested_by    TEXT NOT NULL,
  dry_run         BOOLEAN NOT NULL DEFAULT FALSE,
  grants_matched  INTEGER NOT NULL DEFAULT 0,
  grants_revoked  INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT chk_emergency_stops_scope CHECK (scope_type IN ('grant', 'agent', 'principal', 'developer'))
);

-- Separately, because `CREATE TABLE IF NOT EXISTS` is skipped whole on a
-- database that already has an earlier version of this table — from a release
-- that shipped it without these columns, or from a run of this file before
-- they were added. The columns would then be missing and the first
-- `INSERT … status` would fail with `column "status" does not exist`. A fresh
-- test container never shows it.
ALTER TABLE emergency_stops ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running';
ALTER TABLE emergency_stops ADD COLUMN IF NOT EXISTS sweeps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE emergency_stops ADD COLUMN IF NOT EXISTS error TEXT;

-- `running` while batches are still going; `failed` when one did not finish,
-- so the row can never read as if nothing happened when thousands of grants
-- were revoked. `incomplete` means the sweeps ran out with grants still
-- appearing under the scope.
DO $$
BEGIN
  IF NOT EXISTS (
    -- Scoped to this schema's table: a constraint of the same name on
    -- another schema's copy must not make this one look done.
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_emergency_stops_status'
       AND conrelid = 'emergency_stops'::regclass
  ) THEN
    ALTER TABLE emergency_stops
      ADD CONSTRAINT chk_emergency_stops_status
      CHECK (status IN ('running', 'completed', 'incomplete', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_emergency_stops_developer
  ON emergency_stops (developer_id, started_at DESC);
