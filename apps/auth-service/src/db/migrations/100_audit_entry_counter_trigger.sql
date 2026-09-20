-- Keep audit_entry_counters current (PRD G-5 plan limits). The function only
-- updates rows that already exist; rows are initialised by the application
-- under the developer's audit advisory lock, so no backfill runs at startup.
CREATE OR REPLACE FUNCTION grantex_audit_entry_counter() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE audit_entry_counters SET entry_count = entry_count + 1, updated_at = NOW()
      WHERE developer_id = NEW.developer_id;
    RETURN NEW;
  END IF;
  UPDATE audit_entry_counters SET entry_count = GREATEST(entry_count - 1, 0), updated_at = NOW()
    WHERE developer_id = OLD.developer_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Creating a trigger briefly locks audit_entries. Never let that block
-- startup: wait at most two seconds, otherwise skip with a notice. Until the
-- trigger exists the application counts with COUNT(*) instead of the counter.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_entry_counter_trg') THEN
    PERFORM set_config('lock_timeout', '2s', true);
    BEGIN
      CREATE TRIGGER audit_entry_counter_trg
        AFTER INSERT OR DELETE ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION grantex_audit_entry_counter();
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'audit_entry_counter_trg not created (audit_entries busy); it is created on a later start';
    END;
  END IF;
END
$$;
