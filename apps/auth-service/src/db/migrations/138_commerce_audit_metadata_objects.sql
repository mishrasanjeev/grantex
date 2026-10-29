-- SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
-- Repair: commerce audit metadata stored as a JSON string.
--
-- appendCommerceAudit sent JSON.stringify(metadata) to a `::jsonb`
-- parameter, which postgres.js encodes again, so every row it wrote holds a
-- jsonb *string* whose text is the metadata object, not the object itself
-- (`metadata->>'key'` read NULL). The writer now uses sql.json. This rewrites
-- each such row as the object its string holds.
--
-- Only rows whose metadata is a jsonb string that parses to a JSON object
-- are touched; anything else (already an object, or a string that is not an
-- object) is left as it is. Running it again finds nothing to do.
--
-- commerce_audit_events is append-only by trigger. The update triggers are
-- disabled for this one statement and enabled again in the same transaction
-- (the migration runner wraps the file in one); ALTER TABLE holds an
-- ACCESS EXCLUSIVE lock until commit, so no other session ever sees the
-- table without its triggers. When no row needs repair, no lock is taken.

CREATE OR REPLACE FUNCTION pg_temp.commerce_audit_metadata_object(value JSONB)
RETURNS JSONB AS $$
DECLARE
  parsed JSONB;
BEGIN
  IF jsonb_typeof(value) <> 'string' THEN
    RETURN NULL;
  END IF;
  BEGIN
    parsed := (value #>> '{}')::JSONB;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(parsed) = 'object' THEN
    RETURN parsed;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce_audit_events
     WHERE jsonb_typeof(metadata) = 'string'
       AND pg_temp.commerce_audit_metadata_object(metadata) IS NOT NULL
  ) THEN
    ALTER TABLE commerce_audit_events DISABLE TRIGGER commerce_audit_events_no_update;
    UPDATE commerce_audit_events
       SET metadata = pg_temp.commerce_audit_metadata_object(metadata)
     WHERE jsonb_typeof(metadata) = 'string'
       AND pg_temp.commerce_audit_metadata_object(metadata) IS NOT NULL;
    ALTER TABLE commerce_audit_events ENABLE TRIGGER commerce_audit_events_no_update;
  END IF;
END
$$;

DROP FUNCTION IF EXISTS pg_temp.commerce_audit_metadata_object(JSONB);
