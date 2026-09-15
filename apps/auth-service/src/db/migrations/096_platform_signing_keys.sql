-- Platform signing keys for SIGNING_KEY_STORE=postgres (lib/signing-keys.ts).
-- The active key signs grant tokens, OAuth access tokens and the other
-- platform JWTs. A pending key is published first and becomes active after
-- the activation delay (publish-then-sign rotation). Retired keys stay
-- published for the grace window so tokens they signed keep verifying; a
-- retired key's private key is erased when it is retired. Private keys are
-- encrypted with VAULT_ENCRYPTION_KEY and bound to their kid as additional
-- authenticated data. legacy_kid_alias marks the RSA key that signed tokens
-- with the pre-0.6 kid grantex-YYYY-MM. Additive: unused by the default
-- SIGNING_KEY_STORE=env.

CREATE TABLE IF NOT EXISTS platform_signing_keys (
  kid                       TEXT PRIMARY KEY,
  algorithm                 TEXT NOT NULL,
  public_key_jwk            JSONB NOT NULL,
  encrypted_private_key_jwk TEXT,
  status                    TEXT NOT NULL DEFAULT 'active',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activates_at              TIMESTAMPTZ,
  retired_at                TIMESTAMPTZ,
  legacy_kid_alias          BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT chk_platform_signing_keys_algorithm
    CHECK (algorithm IN ('RS256', 'ES256')),
  CONSTRAINT chk_platform_signing_keys_status
    CHECK (status IN ('pending', 'active', 'retired')),
  CONSTRAINT chk_platform_signing_keys_material
    CHECK (
      (status = 'active' AND encrypted_private_key_jwk IS NOT NULL AND activates_at IS NULL AND retired_at IS NULL)
      OR (status = 'pending' AND encrypted_private_key_jwk IS NOT NULL AND activates_at IS NOT NULL AND retired_at IS NULL)
      OR (status = 'retired' AND encrypted_private_key_jwk IS NULL AND retired_at IS NOT NULL)
    ),
  CONSTRAINT chk_platform_signing_keys_legacy_rsa
    CHECK (NOT legacy_kid_alias OR algorithm = 'RS256')
);

-- At most one active key and one pending key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_signing_keys_active
  ON platform_signing_keys (status) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_signing_keys_pending
  ON platform_signing_keys (status) WHERE status = 'pending';
-- At most one legacy kid key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_signing_keys_legacy
  ON platform_signing_keys (legacy_kid_alias) WHERE legacy_kid_alias;
