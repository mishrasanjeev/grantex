-- Platform signing keys for SIGNING_KEY_STORE=postgres (lib/signing-keys.ts).
-- The active key signs grant tokens, OAuth access tokens and the other
-- platform JWTs; retired keys stay published in the JWK Set for the grace
-- window so tokens they signed keep verifying. A retired key's private key is
-- erased at retirement. Private keys are encrypted with VAULT_ENCRYPTION_KEY
-- (lib/vault-crypto.ts, AES-256-GCM). Additive: unused by the default
-- SIGNING_KEY_STORE=env.

CREATE TABLE IF NOT EXISTS platform_signing_keys (
  kid                       TEXT PRIMARY KEY,
  algorithm                 TEXT NOT NULL,
  public_key_jwk            JSONB NOT NULL,
  encrypted_private_key_jwk TEXT,
  status                    TEXT NOT NULL DEFAULT 'active',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retired_at                TIMESTAMPTZ,
  CONSTRAINT chk_platform_signing_keys_algorithm
    CHECK (algorithm IN ('RS256', 'ES256')),
  CONSTRAINT chk_platform_signing_keys_status
    CHECK (status IN ('active', 'retired')),
  CONSTRAINT chk_platform_signing_keys_active_material
    CHECK (
      (status = 'active' AND encrypted_private_key_jwk IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND encrypted_private_key_jwk IS NULL AND retired_at IS NOT NULL)
    )
);

-- Exactly one active key at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_signing_keys_active
  ON platform_signing_keys (status) WHERE status = 'active';
