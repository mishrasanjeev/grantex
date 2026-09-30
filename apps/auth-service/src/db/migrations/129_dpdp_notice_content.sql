-- SPDX-License-Identifier: Apache-2.0
-- DPDP consent notice content (DPDP Act 2023 s.5; DPDP Rules 2025 r.3):
-- structured fields for the itemised personal data, the specific purposes
-- and the goods or services they enable, the means to withdraw consent,
-- exercise rights and complain to the Board, and the contact person (s.8(9),
-- r.9). One notice version may now exist in several languages, and a consent
-- record keeps the language of the notice it was given against.
--
-- Additive. New nullable columns (no rewrite). The unique key on notices
-- widens from (developer_id, notice_id, version) to include language: every
-- existing row is unique under the old key, so it is unique under the wider
-- one and the index builds on existing data. The new index is built before
-- the old one is dropped, so uniqueness holds throughout. The notices table
-- is small; the build runs inside the migration's transaction.
--
-- Backfill: consent_notice_language is filled for existing records from the
-- notice row whose version and content hash the record stored; a record with
-- no matching row keeps NULL (unknown). The new notice columns stay NULL for
-- existing notices, which the routes report as missing elements.
--
-- notice_hash (on notices, and on a consent record for the notice it was
-- given against) is the SHA-256 of the RFC 8785 canonical JSON of the whole
-- notice (lib/dpdp-notice.ts noticeHash): content_hash covers only the text.
-- It is computed by the service, so it is not backfilled here; for a notice
-- without one the routes compute it from the row, and existing consent
-- records keep NULL (their proofs were signed without it).

ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS itemised_personal_data JSONB;
ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS purpose_details JSONB;
ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS withdrawal_url TEXT;
ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS rights_url TEXT;
ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS board_complaint_url TEXT;
ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS contact JSONB;
ALTER TABLE dpdp_consent_notices
  ADD COLUMN IF NOT EXISTS notice_hash TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dpdp_consent_notices'::regclass
      AND conname = 'chk_dpdp_consent_notices_structured'
  ) THEN
    ALTER TABLE dpdp_consent_notices
      ADD CONSTRAINT chk_dpdp_consent_notices_structured
      CHECK ((itemised_personal_data IS NULL OR jsonb_typeof(itemised_personal_data) = 'array')
         AND (purpose_details IS NULL OR jsonb_typeof(purpose_details) = 'array')
         AND (contact IS NULL OR jsonb_typeof(contact) = 'object')) NOT VALID;
  END IF;
END $$;
ALTER TABLE dpdp_consent_notices VALIDATE CONSTRAINT chk_dpdp_consent_notices_structured;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dpdp_notices_id_version_language
  ON dpdp_consent_notices (developer_id, notice_id, version, language);
DROP INDEX IF EXISTS idx_dpdp_notices_id_version;

ALTER TABLE dpdp_consent_records
  ADD COLUMN IF NOT EXISTS consent_notice_language TEXT;
ALTER TABLE dpdp_consent_records
  ADD COLUMN IF NOT EXISTS notice_hash TEXT;

UPDATE dpdp_consent_records r
SET consent_notice_language = (
  SELECT n.language FROM dpdp_consent_notices n
  WHERE n.developer_id = r.developer_id
    AND n.notice_id = r.consent_notice_id
    AND n.version = r.consent_notice_version
    AND n.content_hash = r.consent_notice_hash
  ORDER BY n.created_at DESC
  LIMIT 1
)
WHERE r.consent_notice_language IS NULL AND r.consent_notice_version IS NOT NULL;
