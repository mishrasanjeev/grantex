-- RFC 8693 actor chain of a delegated grant (lib/grant-token-claims.ts). The
-- delegation endpoint stores the `act` claim it issued so a refreshed token
-- carries the same nested chain. Additive and nullable: grants delegated
-- before this column existed refresh with the delegating agent alone.

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS actor_chain JSONB;
