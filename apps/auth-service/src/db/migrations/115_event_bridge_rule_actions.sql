-- What a mapping rule has already done for one event (PRD G-6).
--
-- Revoking and suspending are idempotent: a repeat finds the grant already
-- revoked and changes nothing. Asking the relying platform to re-evaluate is
-- not — it appends audit entries and emits an event — so a delivery that is
-- retried after a later rule failed would ask twice. This table is the
-- at-most-once key for those actions, claimed in the same transaction that
-- writes them.
--
-- Additive: one new table, created empty, read only while the event bridge is
-- enabled.

CREATE TABLE IF NOT EXISTS event_bridge_rule_actions (
  source_id    TEXT NOT NULL REFERENCES event_bridge_sources(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL,
  event_index  INTEGER NOT NULL DEFAULT 0,
  rule_id      TEXT NOT NULL,
  developer_id TEXT NOT NULL,
  action       TEXT NOT NULL,
  grants       INTEGER NOT NULL DEFAULT 0,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, event_id, event_index, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_event_bridge_rule_actions_developer
  ON event_bridge_rule_actions (developer_id, applied_at DESC);
