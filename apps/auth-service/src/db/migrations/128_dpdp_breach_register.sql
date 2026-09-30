-- SPDX-License-Identifier: Apache-2.0
-- DPDP breach register: personal data breaches a Data Fiduciary records
-- (DPDP Act 2023 s.8(6); DPDP Rules 2025 r.7), the detailed report it sends
-- the Board, and the intimations it gave affected Data Principals.
--
-- Grantex does not send the intimations or file with the Board. It keeps
-- the register, computes the deadlines and emits events (routes/dpdp-breaches.ts,
-- workers/dpdpBreachDeadlines.ts).
--
-- Additive: two new, empty tables and their indexes. No backfill.

CREATE TABLE IF NOT EXISTS dpdp_breaches (
  id                                 TEXT PRIMARY KEY,           -- brch_<ulid>
  developer_id                       TEXT NOT NULL REFERENCES developers(id),
  -- r.7(1)(a): description, nature, extent, timing and location.
  description                        TEXT NOT NULL,
  nature                             TEXT NOT NULL,
  extent                             TEXT NOT NULL,
  occurred_at                        TIMESTAMPTZ,                -- NULL: not yet known
  aware_at                           TIMESTAMPTZ NOT NULL,
  location                           TEXT,
  likely_impact                      TEXT,
  affected_data_principal_ids        TEXT[] NOT NULL DEFAULT '{}',
  affected_count                     INTEGER,
  mitigation                         TEXT,
  status                             TEXT NOT NULL DEFAULT 'open',
  -- r.7(2)(b): the detailed report to the Board.
  report_updated_details             TEXT,
  report_facts_circumstances_reasons TEXT,
  report_mitigation                  TEXT,
  report_cause_findings              TEXT,
  report_remedial_measures           TEXT,
  board_initial_intimation_sent_at   TIMESTAMPTZ,
  board_detailed_report_sent_at      TIMESTAMPTZ,
  -- An extension of the 72-hour period, on the fiduciary's written request.
  -- extension_granted NULL: requested and not yet decided.
  extension_requested_at             TIMESTAMPTZ,
  extension_granted                  BOOLEAN,
  extension_due_at                   TIMESTAMPTZ,
  -- aware_at + 72 hours, or extension_due_at once an extension is granted.
  board_report_due_at                TIMESTAMPTZ NOT NULL,
  -- When the deadline worker last alerted, so each alert goes out once.
  due_alert_sent_at                  TIMESTAMPTZ,
  overdue_alert_sent_at              TIMESTAMPTZ,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                         TIMESTAMPTZ,
  closed_at                          TIMESTAMPTZ,
  CONSTRAINT chk_dpdp_breaches_status
    CHECK (status IN ('open', 'initial_intimated', 'reported', 'closed')),
  CONSTRAINT chk_dpdp_breaches_affected_count
    CHECK (affected_count IS NULL OR affected_count >= 0),
  CONSTRAINT chk_dpdp_breaches_extension
    CHECK (extension_granted IS NOT TRUE OR extension_due_at IS NOT NULL)
);

-- Newest-first pages per developer, with and without the status filter.
CREATE INDEX IF NOT EXISTS idx_dpdp_breaches_developer_created
  ON dpdp_breaches (developer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dpdp_breaches_developer_status_created
  ON dpdp_breaches (developer_id, status, created_at DESC, id DESC);
-- The deadline worker's scan: breaches whose detailed report is not sent.
CREATE INDEX IF NOT EXISTS idx_dpdp_breaches_report_due
  ON dpdp_breaches (board_report_due_at)
  WHERE board_detailed_report_sent_at IS NULL AND status IN ('open', 'initial_intimated');

CREATE TABLE IF NOT EXISTS dpdp_breach_principal_intimations (
  id                 TEXT PRIMARY KEY,                           -- bint_<ulid>
  breach_id          TEXT NOT NULL REFERENCES dpdp_breaches(id),
  developer_id       TEXT NOT NULL REFERENCES developers(id),
  data_principal_ids TEXT[] NOT NULL,
  channel            TEXT NOT NULL,
  intimated_at       TIMESTAMPTZ NOT NULL,
  -- Which r.7(1) elements the intimation carried.
  content_included   TEXT[] NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_dpdp_breach_intimations_principals
    CHECK (cardinality(data_principal_ids) > 0),
  CONSTRAINT chk_dpdp_breach_intimations_content
    CHECK (cardinality(content_included) > 0
           AND content_included <@ ARRAY['description', 'likely_consequences', 'mitigation', 'safety_measures', 'contact']::TEXT[])
);

CREATE INDEX IF NOT EXISTS idx_dpdp_breach_intimations_breach
  ON dpdp_breach_principal_intimations (breach_id, intimated_at DESC);
