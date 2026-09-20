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
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT chk_emergency_stops_scope CHECK (scope_type IN ('grant', 'agent', 'principal', 'developer'))
);

CREATE INDEX IF NOT EXISTS idx_emergency_stops_developer
  ON emergency_stops (developer_id, started_at DESC);
