-- Developer email identity is case-insensitive. Enforce the same invariant in
-- PostgreSQL so concurrent signups cannot both pass an application-level
-- existence check and create duplicate accounts.
DO $$
DECLARE
  duplicate_group_count BIGINT;
BEGIN
  SELECT COUNT(*)
  INTO duplicate_group_count
  FROM (
    SELECT LOWER(email)
    FROM developers
    WHERE email IS NOT NULL
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  ) AS duplicate_groups;

  IF duplicate_group_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce case-insensitive developer email uniqueness: % duplicate group(s) exist',
      duplicate_group_count
      USING HINT = 'Merge or rename duplicates found by: SELECT LOWER(email), COUNT(*) FROM developers WHERE email IS NOT NULL GROUP BY LOWER(email) HAVING COUNT(*) > 1;';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_developers_email_unique
  ON developers (LOWER(email))
  WHERE email IS NOT NULL;
