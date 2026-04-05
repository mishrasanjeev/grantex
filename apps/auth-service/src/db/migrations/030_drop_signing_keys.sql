-- Drop orphaned signing_keys table (created in 019_did_keys.sql but never
-- referenced by any route, service, or query — DID key management uses the
-- Ed25519 key pair from env/crypto module instead).

DROP TABLE IF EXISTS signing_keys;
