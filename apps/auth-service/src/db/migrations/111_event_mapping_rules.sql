-- Event mapping rules, the grant bindings they match on, and suspension state
-- (PRD G-6). Additive: three new tables, created empty. Nothing reads or
-- writes them unless EVENT_BRIDGE_ENABLED=true.
--
-- A rule maps an event type and a subject matcher to one action on the grants
-- it resolves: suspend, revoke or re_evaluate. Rules belong to one developer
-- and can only ever resolve that developer's grants.
--
-- Nothing here alters `grants`. Suspension reuses the existing `status`
-- column (a new value, `suspended`, which every authorisation check already
-- treats as not active) and keeps its bookkeeping in `grant_suspensions`, so
-- this migration never takes a lock on a hot table.

CREATE TABLE IF NOT EXISTS event_mapping_rules (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  source_id    TEXT REFERENCES event_bridge_sources(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  conditions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  target       JSONB NOT NULL,
  action       TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'enforce',
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_event_mapping_rules_action CHECK (action IN ('suspend', 'revoke', 're_evaluate')),
  CONSTRAINT chk_event_mapping_rules_mode CHECK (mode IN ('enforce', 'observe')),
  CONSTRAINT chk_event_mapping_rules_status CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_event_mapping_rules_developer
  ON event_mapping_rules (developer_id, status);

-- Identifiers a developer binds to a grant so provider events about a subject
-- (a business reference, a case id, an order) resolve to it. The kind is the
-- developer's own vocabulary; values are opaque.
CREATE TABLE IF NOT EXISTS grant_subject_refs (
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  grant_id     TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  value        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (grant_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_grant_subject_refs_lookup
  ON grant_subject_refs (developer_id, kind, value);

-- One row per suspended grant: which suspension it belongs to (the root of the
-- subtree one action suspended) and when. Resuming restores exactly the grants
-- of one root; revoking a grant removes its row, so a revoked grant can never
-- be resumed.
CREATE TABLE IF NOT EXISTS grant_suspensions (
  grant_id      TEXT PRIMARY KEY REFERENCES grants(id) ON DELETE CASCADE,
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  root_grant_id TEXT NOT NULL,
  cause         TEXT NOT NULL DEFAULT 'event',
  suspended_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grant_suspensions_root
  ON grant_suspensions (developer_id, root_grant_id);
