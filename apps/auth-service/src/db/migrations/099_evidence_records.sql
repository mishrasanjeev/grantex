-- Evidence packages (PRD G-5). Additive: new tables only, created empty, so
-- startup never scans or locks an existing table.
--
-- evidence_records indexes every evidence record appended through
-- POST /v1/evidence/cases/{caseId}/records (and voids). The record itself is the
-- audit_entries row named by audit_entry_id, which export re-verifies; this
-- table gives the case its server recording order (seq), idempotency on the
-- record's own id, and the data needed to validate references at write time.
CREATE TABLE IF NOT EXISTS evidence_records (
  seq             BIGSERIAL PRIMARY KEY,
  developer_id    TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  case_id         TEXT NOT NULL,
  record_type     TEXT NOT NULL,
  record_key      TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  data            JSONB NOT NULL,
  audit_entry_id  TEXT NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  late            BOOLEAN NOT NULL DEFAULT FALSE,
  voided_at       TIMESTAMPTZ,
  UNIQUE (developer_id, case_id, record_type, record_key)
);

CREATE INDEX IF NOT EXISTS evidence_records_case_seq_idx
  ON evidence_records (developer_id, case_id, seq);

-- Per-case state: the leaf of the grant chain the case's tool calls use (set on
-- the first tool call, moved down the chain only) and when the case was first
-- exported (records after that are marked late).
CREATE TABLE IF NOT EXISTS evidence_cases (
  developer_id       TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  case_id            TEXT NOT NULL,
  grant_leaf_id      TEXT,
  first_exported_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, case_id)
);

-- Audit entry count per developer, for plan limits without COUNT(*). A row is
-- created (from one COUNT under the developer's audit advisory lock) the first
-- time a writer needs it; the trigger in 100_audit_entry_counter_trigger.sql
-- keeps existing rows current for every writer.
CREATE TABLE IF NOT EXISTS audit_entry_counters (
  developer_id  TEXT PRIMARY KEY REFERENCES developers(id) ON DELETE CASCADE,
  entry_count   BIGINT NOT NULL CHECK (entry_count >= 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
