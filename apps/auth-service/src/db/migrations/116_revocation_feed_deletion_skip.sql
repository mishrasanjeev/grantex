-- A grant whose revocation is already on the feed must not appear again when
-- its rows are deleted.
--
-- Cascade revocation sets `grants.status = 'revoked'` and leaves
-- `grant_tokens.is_revoked` alone — the grant's status is what every
-- authorisation check reads, and rewriting every token row would be a second
-- write for no benefit. So when `DELETE /v1/agents/:id` later removes that
-- agent, the grant trigger correctly skips the already-revoked grant while
-- the token trigger sees `is_revoked = FALSE` and writes a second entry
-- (`token_revoked` / `deleted`) for a credential the feed already reported.
--
-- That is not a correctness problem for a client — it is told twice about
-- something already revoked — but it re-inflates the feed exactly when it is
-- being pruned, and it makes `grantex_revocation_feed_entries_total` count
-- revocations that did not happen.
--
-- Additive: replaces one trigger function. No table is touched.

CREATE OR REPLACE FUNCTION grantex_token_deletion_event() RETURNS trigger AS $$
DECLARE
  owner  TEXT;
  state  TEXT;
BEGIN
  IF OLD.is_revoked IS TRUE OR OLD.expires_at <= NOW() THEN
    RETURN OLD;
  END IF;
  -- Tokens are deleted before their grant, so the owner is still readable.
  -- If it is not, the grant's own deletion entry covers the same credential.
  SELECT g.developer_id, g.status INTO owner, state FROM grants g WHERE g.id = OLD.grant_id;
  IF owner IS NULL THEN
    RETURN OLD;
  END IF;
  -- The grant is already revoked, so its entry is already on the feed.
  IF state = 'revoked' THEN
    RETURN OLD;
  END IF;
  INSERT INTO grant_revocation_events (developer_id, grant_id, jti, action, cause, expires_at)
  VALUES (owner, OLD.grant_id, OLD.jti, 'token_revoked', 'deleted', OLD.expires_at);
  PERFORM pg_notify('grantex_revocation', owner);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
