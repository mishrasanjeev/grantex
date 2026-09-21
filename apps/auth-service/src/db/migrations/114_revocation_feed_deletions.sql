-- A grant can also stop by being deleted: DELETE /v1/agents/:id removes an
-- agent's grants and their tokens outright (routes/agents.ts). The status
-- triggers in 112 never fire for that, and a deleted row cannot appear in the
-- snapshot either, so without this a client following the feed would keep
-- authorising those tokens until they expired.
--
-- Additive: two more triggers on the same tables, writing the same feed rows.

CREATE OR REPLACE FUNCTION grantex_grant_deletion_event() RETURNS trigger AS $$
BEGIN
  -- A grant that was already revoked has its entry in the feed; deleting the
  -- row afterwards is housekeeping, not a new revocation.
  IF OLD.status = 'revoked' THEN
    RETURN OLD;
  END IF;
  INSERT INTO grant_revocation_events (developer_id, grant_id, action, cause, expires_at)
  VALUES (OLD.developer_id, OLD.id, 'revoked', 'deleted', OLD.expires_at);
  PERFORM pg_notify('grantex_revocation', OLD.developer_id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION grantex_token_deletion_event() RETURNS trigger AS $$
DECLARE
  owner TEXT;
BEGIN
  IF OLD.is_revoked IS TRUE OR OLD.expires_at <= NOW() THEN
    RETURN OLD;
  END IF;
  -- Tokens are deleted before their grant, so the owner is still readable.
  -- If it is not, the grant's own deletion entry covers the same credential.
  SELECT g.developer_id INTO owner FROM grants g WHERE g.id = OLD.grant_id;
  IF owner IS NULL THEN
    RETURN OLD;
  END IF;
  INSERT INTO grant_revocation_events (developer_id, grant_id, jti, action, cause, expires_at)
  VALUES (owner, OLD.grant_id, OLD.jti, 'token_revoked', 'deleted', OLD.expires_at);
  PERFORM pg_notify('grantex_revocation', owner);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

-- Creating a trigger locks the table it is on. Never let that block startup:
-- wait at most two seconds, otherwise skip with a notice and create it on a
-- later start. Until both exist the feed endpoints report themselves
-- unavailable (lib/revocation-feed/store.ts) and clients fail closed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'grant_deletion_event_trg') THEN
    PERFORM set_config('lock_timeout', '2s', true);
    BEGIN
      CREATE TRIGGER grant_deletion_event_trg
        AFTER DELETE ON grants
        FOR EACH ROW EXECUTE FUNCTION grantex_grant_deletion_event();
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'grant_deletion_event_trg not created (grants busy); it is created on a later start';
    END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'grant_token_deletion_event_trg') THEN
    PERFORM set_config('lock_timeout', '2s', true);
    BEGIN
      CREATE TRIGGER grant_token_deletion_event_trg
        AFTER DELETE ON grant_tokens
        FOR EACH ROW EXECUTE FUNCTION grantex_token_deletion_event();
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'grant_token_deletion_event_trg not created (grant_tokens busy); it is created on a later start';
    END;
  END IF;
END
$$;
