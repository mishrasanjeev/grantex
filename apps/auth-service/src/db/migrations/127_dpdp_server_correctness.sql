-- SPDX-License-Identifier: Apache-2.0
-- DPDP routes: persisted erasure requests, the notice version a consent
-- record was given against, the grievance response period, what an export
-- was filtered to, and CHECK constraints on the status columns of the tables
-- migration 027 created.
--
-- Additive. New nullable columns (no rewrite), columns with constant
-- defaults (no rewrite since PostgreSQL 11), one new empty table, indexes on
-- small tables, and CHECK constraints added NOT VALID and then validated, so
-- the validation scan does not hold an ACCESS EXCLUSIVE lock. The status
-- values allowed are every value the routes have ever written, so validation
-- cannot fail on existing rows.
--
-- Backfill: JSONB values the routes stored double-encoded are decoded (see
-- below). consent_notice_version is filled for existing records from the
-- notice version whose content hash the record stored; a record whose notice
-- has no matching version keeps NULL (unknown), which the routes report as
-- null. Nothing else needs one.

-- ── Double-encoded JSON ─────────────────────────────────────────────────────
--
-- The routes used to bind JSON.stringify(value) to JSONB columns, which the
-- driver encodes once more: the column held a JSON string whose text was the
-- intended value, and reads returned that string. Every such string was
-- written by JSON.stringify, so it parses; decode it in place.

UPDATE dpdp_consent_records SET purposes = (purposes #>> '{}')::jsonb
  WHERE jsonb_typeof(purposes) = 'string';
UPDATE dpdp_consent_records SET consent_proof = (consent_proof #>> '{}')::jsonb
  WHERE jsonb_typeof(consent_proof) = 'string';
UPDATE dpdp_consent_notices SET purposes = (purposes #>> '{}')::jsonb
  WHERE jsonb_typeof(purposes) = 'string';
UPDATE dpdp_consent_notices SET grievance_officer = (grievance_officer #>> '{}')::jsonb
  WHERE grievance_officer IS NOT NULL AND jsonb_typeof(grievance_officer) = 'string';
UPDATE dpdp_grievances SET evidence = (evidence #>> '{}')::jsonb
  WHERE jsonb_typeof(evidence) = 'string';
UPDATE dpdp_exports SET data = (data #>> '{}')::jsonb
  WHERE data IS NOT NULL AND jsonb_typeof(data) = 'string';

-- ── Consent records ─────────────────────────────────────────────────────────

ALTER TABLE dpdp_consent_records
  ADD COLUMN IF NOT EXISTS consent_notice_version TEXT;
ALTER TABLE dpdp_consent_records
  ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ;

UPDATE dpdp_consent_records r
SET consent_notice_version = (
  SELECT n.version FROM dpdp_consent_notices n
  WHERE n.developer_id = r.developer_id
    AND n.notice_id = r.consent_notice_id
    AND n.content_hash = r.consent_notice_hash
  ORDER BY n.created_at DESC
  LIMIT 1
)
WHERE r.consent_notice_version IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dpdp_consent_records'::regclass
      AND conname = 'chk_dpdp_consent_records_status'
  ) THEN
    ALTER TABLE dpdp_consent_records
      ADD CONSTRAINT chk_dpdp_consent_records_status
      CHECK (status IN ('active', 'withdrawn', 'erased', 'expired')) NOT VALID;
  END IF;
END $$;
ALTER TABLE dpdp_consent_records VALIDATE CONSTRAINT chk_dpdp_consent_records_status;

-- Newest-first pages per developer (GET /v1/dpdp/consent-records) and per
-- data principal (GET /v1/dpdp/data-principals/:id/records).
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_developer_created
  ON dpdp_consent_records (developer_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_developer_principal_created
  ON dpdp_consent_records (developer_id, data_principal_id, created_at DESC, id DESC);
-- The consent expiry worker's scan.
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_active_expiry
  ON dpdp_consent_records (processing_expires_at)
  WHERE status = 'active';

-- ── Consent notices ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_dpdp_notices_developer_created
  ON dpdp_consent_notices (developer_id, created_at DESC, id DESC);

-- ── Grievances ──────────────────────────────────────────────────────────────

-- The response period the fiduciary publishes, in days. DPDP Rules 2025
-- r.14(3) cap a published period at 90 days; 7 stays the default.
ALTER TABLE dpdp_grievances
  ADD COLUMN IF NOT EXISTS response_period_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE dpdp_grievances
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dpdp_grievances'::regclass
      AND conname = 'chk_dpdp_grievances_status'
  ) THEN
    ALTER TABLE dpdp_grievances
      ADD CONSTRAINT chk_dpdp_grievances_status
      CHECK (status IN ('submitted', 'in_review', 'resolved', 'rejected')) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dpdp_grievances'::regclass
      AND conname = 'chk_dpdp_grievances_response_period_days'
  ) THEN
    ALTER TABLE dpdp_grievances
      ADD CONSTRAINT chk_dpdp_grievances_response_period_days
      CHECK (response_period_days BETWEEN 1 AND 90) NOT VALID;
  END IF;
END $$;
ALTER TABLE dpdp_grievances VALIDATE CONSTRAINT chk_dpdp_grievances_status;
ALTER TABLE dpdp_grievances VALIDATE CONSTRAINT chk_dpdp_grievances_response_period_days;

CREATE INDEX IF NOT EXISTS idx_dpdp_grievances_developer_created
  ON dpdp_grievances (developer_id, created_at DESC, id DESC);

-- ── Exports ─────────────────────────────────────────────────────────────────

-- The data principal an export was filtered to (NULL: not filtered), so an
-- erasure can delete it, and whether the audit log in it hit the row cap.
ALTER TABLE dpdp_exports
  ADD COLUMN IF NOT EXISTS data_principal_id TEXT;
ALTER TABLE dpdp_exports
  ADD COLUMN IF NOT EXISTS truncated BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dpdp_exports'::regclass
      AND conname = 'chk_dpdp_exports_status'
  ) THEN
    -- 'expired': past expires_at, data purged.
    ALTER TABLE dpdp_exports
      ADD CONSTRAINT chk_dpdp_exports_status
      CHECK (status IN ('complete', 'expired')) NOT VALID;
  END IF;
END $$;
ALTER TABLE dpdp_exports VALIDATE CONSTRAINT chk_dpdp_exports_status;

CREATE INDEX IF NOT EXISTS idx_dpdp_exports_developer
  ON dpdp_exports (developer_id);
CREATE INDEX IF NOT EXISTS idx_dpdp_exports_developer_principal
  ON dpdp_exports (developer_id, data_principal_id)
  WHERE data_principal_id IS NOT NULL;

-- ── Erasure requests ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dpdp_erasure_requests (
  id                        TEXT PRIMARY KEY,           -- ER-<year>-<ulid>
  developer_id              TEXT NOT NULL REFERENCES developers(id),
  data_principal_id         TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'completed',
  records_erased            INTEGER NOT NULL DEFAULT 0,
  -- The principal's own grants this request revoked (active ones only),
  -- and the grants delegated from them revoked in the same cascade.
  grants_revoked            INTEGER NOT NULL DEFAULT 0,
  delegated_grants_revoked  INTEGER NOT NULL DEFAULT 0,
  grievances_redacted       INTEGER NOT NULL DEFAULT 0,
  exports_deleted           INTEGER NOT NULL DEFAULT 0,
  -- What was kept rather than erased, and why: [{category, count?, reason}].
  retained                  JSONB NOT NULL DEFAULT '[]',
  submitted_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at              TIMESTAMPTZ,
  CONSTRAINT chk_dpdp_erasure_requests_status CHECK (status IN ('completed')),
  CONSTRAINT chk_dpdp_erasure_requests_retained CHECK (jsonb_typeof(retained) = 'array'),
  CONSTRAINT chk_dpdp_erasure_requests_counts CHECK (
    records_erased >= 0 AND grants_revoked >= 0 AND delegated_grants_revoked >= 0
    AND grievances_redacted >= 0 AND exports_deleted >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_dpdp_erasure_requests_principal
  ON dpdp_erasure_requests (developer_id, data_principal_id, submitted_at DESC);
