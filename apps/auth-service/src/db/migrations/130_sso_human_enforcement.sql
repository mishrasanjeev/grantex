-- Human SSO enforcement is opt-in per organization. Existing legacy connection
-- flags do not enable it during migration.
ALTER TABLE developers ADD COLUMN IF NOT EXISTS sso_enforced BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE developers ADD COLUMN IF NOT EXISTS sso_subject_namespace BOOLEAN NOT NULL DEFAULT false;

-- The public session ID is an audit identifier, never a bearer credential.
ALTER TABLE sso_sessions ADD COLUMN IF NOT EXISTS token_hash TEXT;
ALTER TABLE sso_sessions ADD COLUMN IF NOT EXISTS subject_namespace_version SMALLINT NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS sso_sessions_token_hash_idx
  ON sso_sessions (token_hash) WHERE token_hash IS NOT NULL;

-- Earlier writes encoded the JSON object as a JSONB string. Normalize valid
-- objects; leave malformed legacy data untouched so startup stays safe.
DO $$
DECLARE record_row RECORD;
DECLARE decoded JSONB;
BEGIN
  FOR record_row IN SELECT id, group_mappings FROM sso_connections
                    WHERE jsonb_typeof(group_mappings) = 'string'
  LOOP
    BEGIN
      decoded := (record_row.group_mappings #>> '{}')::jsonb;
      IF jsonb_typeof(decoded) = 'object' THEN
        UPDATE sso_connections SET group_mappings = decoded WHERE id = record_row.id;
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      NULL;
    END;
  END LOOP;
END $$;
