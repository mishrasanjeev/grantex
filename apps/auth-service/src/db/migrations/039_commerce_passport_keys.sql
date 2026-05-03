-- Grantex Commerce V1 — Milestone 2: ES256 passport key store.
-- Decision D: DB-backed; private JWK encrypted with the existing vault
-- encryption key (lib/vault-crypto.ts AES-256-GCM, base64-stored).
-- Production must refuse silent auto-generation on restart;
-- COMMERCE_AUTO_GENERATE_PASSPORT_KEY=true gates the dev/test path
-- (see lib/commerce/passport-keys.ts).
--
-- kid format `commerce-passport-YYYYMMDD-XXXXXXXX` (spec §6) — namespace
-- enforced at the constraint level so an unknown-namespace kid can never
-- enter via the backing store, only via attacker-supplied JWT headers
-- (which the verifier rejects on lookup miss).

CREATE TABLE IF NOT EXISTS commerce_passport_keys (
  kid                       TEXT PRIMARY KEY,
  algorithm                 TEXT NOT NULL,                              -- ES256 only in V1
  public_key_jwk            JSONB NOT NULL,
  encrypted_private_key_jwk TEXT NOT NULL,                              -- AES-256-GCM via vault-crypto.encrypt()
  status                    TEXT NOT NULL DEFAULT 'active',             -- active | retired | compromised
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at                TIMESTAMPTZ,
  last_used_at              TIMESTAMPTZ,
  CONSTRAINT chk_commerce_passport_keys_kid_format
    CHECK (kid ~ '^commerce-passport-[0-9]{8}-[a-z0-9]{8}$'),
  CONSTRAINT chk_commerce_passport_keys_algorithm
    CHECK (algorithm = 'ES256'),
  CONSTRAINT chk_commerce_passport_keys_status
    CHECK (status IN ('active','retired','compromised'))
);

-- Exactly one active key at a time. Retired keys remain queryable for
-- JWKS publication during the rotation grace window (spec §6).
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_passport_keys_active
  ON commerce_passport_keys(status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_commerce_passport_keys_status
  ON commerce_passport_keys(status);
