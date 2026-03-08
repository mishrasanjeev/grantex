-- WebAuthn credential storage (FIDO2 passkeys)
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id                TEXT PRIMARY KEY,
  principal_id      TEXT NOT NULL,
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  credential_id     TEXT NOT NULL,
  public_key        TEXT NOT NULL,
  counter           BIGINT NOT NULL DEFAULT 0,
  transports        TEXT[] DEFAULT '{}',
  aaguid            TEXT,
  attestation_fmt   TEXT,
  device_name       TEXT,
  backed_up         BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webauthn_cred_uniq
  ON webauthn_credentials (developer_id, credential_id);

CREATE INDEX IF NOT EXISTS idx_webauthn_cred_principal
  ON webauthn_credentials (principal_id, developer_id);

-- WebAuthn challenges (transient, 5-min TTL)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id             TEXT PRIMARY KEY,
  challenge      TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  developer_id   TEXT NOT NULL REFERENCES developers(id),
  ceremony_type  TEXT NOT NULL,
  auth_request_id TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry
  ON webauthn_challenges (expires_at) WHERE consumed = FALSE;

-- Developer-level FIDO settings
ALTER TABLE developers ADD COLUMN IF NOT EXISTS fido_required BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE developers ADD COLUMN IF NOT EXISTS fido_rp_name TEXT;

-- Track FIDO assertion on grants and auth requests
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fido_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fido_credential_id TEXT;
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS fido_verified BOOLEAN NOT NULL DEFAULT FALSE;
