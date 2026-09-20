-- The revocation feed (PRD G-6): an append-only log of every grant and token
-- revocation, so an SDK holding a verified token learns about a revocation
-- within seconds instead of at the token's expiry.
--
-- The log is filled by triggers rather than by each revocation path, so every
-- way a grant stops (DELETE /v1/grants/:id, cascade revocation from an event,
-- an emergency stop, consent withdrawal, an anomaly, a DPDP erasure, OAuth
-- revocation) reaches the feed with no change to that code, and the row is
-- written in the same transaction as the revocation itself.
--
-- `pg_notify` fires on commit, so a receiver is woken only by revocations that
-- actually happened. Instances also poll, so a missed notification costs
-- latency, never correctness.

CREATE TABLE IF NOT EXISTS grant_revocation_events (
  seq           BIGSERIAL PRIMARY KEY,
  developer_id  TEXT NOT NULL,
  grant_id      TEXT,
  jti           TEXT,
  action        TEXT NOT NULL,
  cause         TEXT,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_grant_revocation_events_action
    CHECK (action IN ('revoked', 'suspended', 'resumed', 'token_revoked'))
);

CREATE INDEX IF NOT EXISTS idx_grant_revocation_events_developer_seq
  ON grant_revocation_events (developer_id, seq);

CREATE INDEX IF NOT EXISTS idx_grant_revocation_events_created
  ON grant_revocation_events (created_at);

CREATE OR REPLACE FUNCTION grantex_grant_revocation_event() RETURNS trigger AS $$
DECLARE
  event_action TEXT;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'revoked' THEN
    event_action := 'revoked';
  ELSIF NEW.status = 'suspended' THEN
    event_action := 'suspended';
  ELSIF NEW.status = 'active' AND OLD.status = 'suspended' THEN
    event_action := 'resumed';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO grant_revocation_events (developer_id, grant_id, action, expires_at)
  VALUES (NEW.developer_id, NEW.id, event_action, NEW.expires_at);
  PERFORM pg_notify('grantex_revocation', NEW.developer_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION grantex_token_revocation_event() RETURNS trigger AS $$
DECLARE
  owner TEXT;
BEGIN
  IF NEW.is_revoked IS NOT TRUE OR OLD.is_revoked IS TRUE THEN
    RETURN NEW;
  END IF;
  SELECT g.developer_id INTO owner FROM grants g WHERE g.id = NEW.grant_id;
  IF owner IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO grant_revocation_events (developer_id, grant_id, jti, action, expires_at)
  VALUES (owner, NEW.grant_id, NEW.jti, 'token_revoked', NEW.expires_at);
  PERFORM pg_notify('grantex_revocation', owner);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Creating a trigger locks the table it is on. Never let that block startup:
-- wait at most two seconds, otherwise skip with a notice and create it on a
-- later start. Until both triggers exist the revocation feed endpoints report
-- themselves unavailable, and SDK clients using the feed fail closed, rather
-- than serving a feed that could miss a revocation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'grant_revocation_event_trg') THEN
    PERFORM set_config('lock_timeout', '2s', true);
    BEGIN
      CREATE TRIGGER grant_revocation_event_trg
        AFTER UPDATE OF status ON grants
        FOR EACH ROW EXECUTE FUNCTION grantex_grant_revocation_event();
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'grant_revocation_event_trg not created (grants busy); it is created on a later start';
    END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'grant_token_revocation_event_trg') THEN
    PERFORM set_config('lock_timeout', '2s', true);
    BEGIN
      CREATE TRIGGER grant_token_revocation_event_trg
        AFTER UPDATE OF is_revoked ON grant_tokens
        FOR EACH ROW EXECUTE FUNCTION grantex_token_revocation_event();
    EXCEPTION WHEN lock_not_available THEN
      RAISE NOTICE 'grant_token_revocation_event_trg not created (grant_tokens busy); it is created on a later start';
    END;
  END IF;
END
$$;
