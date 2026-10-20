-- SPDX-License-Identifier: Apache-2.0
-- OACP mandates and presence (Phase 4).
--
-- Additive: nullable columns on two tables and one new table, created empty,
-- plus a repair of mis-encoded commerce passport public keys (section 3).
--
-- 1. Presence and authentication methods on the consent record and the
--    Commerce Passport (G44). `presence` says whether the buyer will be
--    present when the agent buys (`human_present`: each cart is confirmed
--    with the buyer's passkey) or delegated the purchase
--    (`human_not_present`: the agent buys within the consented caps without
--    a further human step). `amr` lists the authentication methods behind the
--    consent (RFC 8176 values where one exists, e.g. `otp`, plus `consent`).
--    Both columns are nullable: rows written before this migration carry
--    NULL, which every reader treats as `human_not_present` (the stricter
--    rule set for a relying party) with no methods.
--
-- Every statement is idempotent: the migration ledger may run a file again
-- on a database that predates the ledger.

ALTER TABLE commerce_consent_records ADD COLUMN IF NOT EXISTS presence TEXT;
ALTER TABLE commerce_consent_records ADD COLUMN IF NOT EXISTS amr TEXT[];
ALTER TABLE commerce_passports ADD COLUMN IF NOT EXISTS presence TEXT;
ALTER TABLE commerce_passports ADD COLUMN IF NOT EXISTS amr TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_consent_presence') THEN
    ALTER TABLE commerce_consent_records
      ADD CONSTRAINT chk_consent_presence
      CHECK (presence IS NULL OR presence IN ('human_present', 'human_not_present'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_passport_presence') THEN
    ALTER TABLE commerce_passports
      ADD CONSTRAINT chk_passport_presence
      CHECK (presence IS NULL OR presence IN ('human_present', 'human_not_present'));
  END IF;
END
$$;

-- 2. OACP mandates (G41, G45, G46): Intent, Cart and Payment mandates issued
--    as ES256 JWTs by an OACP issuer key (`oacp-` kid, in the JWKS while any
--    mandate it signed is unexpired), each on the OACP Token Status List
--    (entry allocated in the issuing transaction; `oacp_status_entries`
--    .artifact_id holds the mandate jti). Refused issuances are recorded too,
--    without a token. A cart mandate names its intent and a payment mandate
--    its cart (`parent_jti`); revoking a mandate revokes its descendants.
--    tenant_id is the commerce tenant of the Commerce Passport behind the
--    mandate (no foreign key, as for oacp_artifacts: refusals may name an
--    unknown tenant).

CREATE TABLE IF NOT EXISTS oacp_mandates (
  jti                    TEXT PRIMARY KEY,
  mandate_type           TEXT NOT NULL,
  tenant_id              TEXT,
  merchant_id            TEXT,
  buyer_agent_id         TEXT,
  subject                TEXT,
  presence               TEXT,
  amr                    TEXT[],
  passport_jti           TEXT,
  consent_record_id      TEXT,
  parent_jti             TEXT REFERENCES oacp_mandates(jti),
  issuer_key_id          TEXT REFERENCES oacp_issuer_keys(kid),
  -- The compact JWT, and its lowercase hex SHA-256 (AgenticOrg's mandate_hash).
  jwt                    TEXT,
  jwt_sha256             TEXT,
  claims                 JSONB,
  -- AP2 checkout_hash (cart) / transaction_id (payment).
  checkout_hash          TEXT,
  amount                 BIGINT,
  currency               TEXT,
  -- G45: the verified WebAuthn assertion of a human-present cart, as a
  -- GrantexWebAuthnAssertion (lib/webauthn-evidence.ts), and a hash of its
  -- signature so one assertion can back one mandate only.
  webauthn_evidence      JSONB,
  webauthn_assertion_hash TEXT UNIQUE,
  status_list_uri        TEXT,
  status_idx             INTEGER,
  issued_at              TIMESTAMPTZ,
  expires_at             TIMESTAMPTZ,
  status                 TEXT NOT NULL,
  refusal_code           TEXT,
  request_id             TEXT,
  revoked_at             TIMESTAMPTZ,
  revocation_reason      TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT chk_oacp_mandates_jti CHECK (jti ~ '^oacp_(mnd|mref)_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT chk_oacp_mandates_type CHECK (mandate_type IN ('intent', 'cart', 'payment')),
  CONSTRAINT chk_oacp_mandates_status CHECK (status IN ('issued', 'refused', 'revoked')),
  CONSTRAINT chk_oacp_mandates_presence CHECK (presence IS NULL OR presence IN ('human_present', 'human_not_present')),
  -- An issued or revoked mandate is a signed token on a status list.
  CONSTRAINT chk_oacp_mandates_signed CHECK (
    status = 'refused' OR (
      jti LIKE 'oacp_mnd_%' AND tenant_id IS NOT NULL AND merchant_id IS NOT NULL
      AND buyer_agent_id IS NOT NULL AND subject IS NOT NULL AND presence IS NOT NULL
      AND amr IS NOT NULL AND passport_jti IS NOT NULL AND consent_record_id IS NOT NULL
      AND issuer_key_id IS NOT NULL AND jwt IS NOT NULL AND jwt_sha256 ~ '^[0-9a-f]{64}$'
      AND claims IS NOT NULL AND status_list_uri IS NOT NULL AND status_idx IS NOT NULL
      AND issued_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at > issued_at
      AND refusal_code IS NULL
      AND (mandate_type = 'intent') = (parent_jti IS NULL)
    )
  ),
  -- A refusal is a record, never a token.
  CONSTRAINT chk_oacp_mandates_refused CHECK (
    status <> 'refused' OR (
      jti LIKE 'oacp_mref_%' AND refusal_code IS NOT NULL AND jwt IS NULL AND jwt_sha256 IS NULL
      AND status_list_uri IS NULL AND status_idx IS NULL AND webauthn_evidence IS NULL
    )
  ),
  -- G45: a human-present cart is issued only with a verified passkey assertion.
  CONSTRAINT chk_oacp_mandates_human_present_cart CHECK (
    status = 'refused' OR mandate_type <> 'cart' OR presence <> 'human_present'
    OR (webauthn_evidence IS NOT NULL AND webauthn_assertion_hash IS NOT NULL)
  ),
  CONSTRAINT chk_oacp_mandates_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_oacp_mandates_tenant_created
  ON oacp_mandates (tenant_id, created_at, jti);
CREATE INDEX IF NOT EXISTS idx_oacp_mandates_parent
  ON oacp_mandates (parent_jti) WHERE parent_jti IS NOT NULL;
-- JWKS publication: is any unexpired mandate still signed by a retired key?
CREATE INDEX IF NOT EXISTS idx_oacp_mandates_issuer_key_expires
  ON oacp_mandates (issuer_key_id, expires_at) WHERE status <> 'refused';

-- Rows are inserted and revoked (UPDATE), never deleted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON oacp_mandates TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON oacp_mandates FROM grantex_app';
  END IF;
END
$$;

-- 3. Repair: commerce passport public keys auto-generated before this
--    migration were stored as a JSON string inside jsonb (the insert passed
--    JSON.stringify(jwk) to a jsonb parameter, which postgres.js encodes
--    again). Verification then failed and the JWKS published a string. Store
--    them as objects; rows already objects are untouched.
UPDATE commerce_passport_keys
   SET public_key_jwk = (public_key_jwk #>> '{}')::jsonb
 WHERE jsonb_typeof(public_key_jwk) = 'string';
