-- StatusList2021 bitstrings are fixed-capacity (131072 bits by default).
-- A UNIQUE index on (developer_id, purpose) capped every developer at exactly
-- one list forever, so once next_index passed `size` each new credential was
-- assigned an out-of-range index. Setting an out-of-range bit on a Buffer is a
-- silent no-op in Node, so those credentials could never be revoked and no
-- error was ever raised. Allow a developer to roll over onto additional lists.
DROP INDEX IF EXISTS idx_vc_status_list_dev_purpose;

CREATE INDEX IF NOT EXISTS idx_vc_status_list_dev_purpose
  ON vc_status_lists(developer_id, purpose);

-- With more than one list per developer, an index alone no longer identifies a
-- bit: revocation has to know which list the index belongs to.
ALTER TABLE verifiable_credentials
  ADD COLUMN IF NOT EXISTS status_list_id TEXT;

ALTER TABLE mpp_passports
  ADD COLUMN IF NOT EXISTS status_list_id TEXT;

-- Backfill. Every row issued before this migration belongs to the developer's
-- single pre-existing list, which is also their oldest.
UPDATE verifiable_credentials vc
SET status_list_id = (
  SELECT l.id FROM vc_status_lists l
  WHERE l.developer_id = vc.developer_id AND l.purpose = 'revocation'
  ORDER BY l.created_at ASC, l.id ASC
  LIMIT 1
)
WHERE vc.status_list_id IS NULL;

UPDATE mpp_passports p
SET status_list_id = (
  SELECT l.id FROM vc_status_lists l
  WHERE l.developer_id = p.developer_id AND l.purpose = 'revocation'
  ORDER BY l.created_at ASC, l.id ASC
  LIMIT 1
)
WHERE p.status_list_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_vc_status_list_ref
  ON verifiable_credentials(status_list_id);

CREATE INDEX IF NOT EXISTS idx_mpp_passport_status_list_ref
  ON mpp_passports(status_list_id);
