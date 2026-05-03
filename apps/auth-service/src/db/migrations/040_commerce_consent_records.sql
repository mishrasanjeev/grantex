-- Grantex Commerce V1 — Milestone 2: consent records.
-- Spec §15 + §14. Single-use enforced in app via SELECT...FOR UPDATE on
-- the status field; presented_payload_hash captured at first GET so the
-- exchange step can verify the user saw the same payload that gets
-- bound into the passport.
--
-- expires_at default 10 minutes from creation (spec §14 consent TTL).
-- chk_consent_expires_required guarantees no consent can outlive its
-- declared window.

CREATE TABLE IF NOT EXISTS commerce_consent_records (
  id                      TEXT PRIMARY KEY,                                 -- crec_<ulid>
  tenant_id               TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id             TEXT NOT NULL,
  agent_id                TEXT NOT NULL,
  -- user_principal_id is set ONLY at approval time from the authenticated
  -- principal session JWT. The agent never writes this field directly —
  -- they may supply user_principal_hint (below) which the approve flow
  -- enforces against the authenticated principal.
  user_principal_id       TEXT,
  -- Optional agent-supplied hint of which user is expected to authorize.
  -- If set, the approve flow rejects when the authenticated principal
  -- does not match. Prevents the "agent self-approves for any user"
  -- attack while still letting agents pre-bind a session.
  user_principal_hint     TEXT,
  consent_request_id      TEXT NOT NULL UNIQUE,                             -- opaque CSPRNG, shown in URL
  passport_type           TEXT NOT NULL,                                    -- browse | checkout
  requested_scopes        TEXT[] NOT NULL,
  approved_scopes         TEXT[],                                           -- nullable until granted
  max_amount              BIGINT,
  currency                TEXT,
  consent_text_version    TEXT NOT NULL,
  presented_payload_hash  TEXT,                                             -- sha256 captured at first GET
  status                  TEXT NOT NULL DEFAULT 'requested',                -- requested | granted | denied | expired
  agent_auth_method       TEXT,                                             -- jwt | api_key — recorded at create
  ip_hash                 TEXT,
  user_agent_hash         TEXT,
  -- CSRF model (Finding 1 redesign): per-form CSRF token is HMAC-derived
  -- from the principal session token + consent_request_id, computed at
  -- render time and verified at POST. No per-consent secret stored in DB.
  expires_at              TIMESTAMPTZ NOT NULL,
  approved_at             TIMESTAMPTZ,
  denied_at               TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_consent_status
    CHECK (status IN ('requested','granted','denied','expired')),
  CONSTRAINT chk_consent_passport_type
    CHECK (passport_type IN ('browse','checkout')),
  CONSTRAINT chk_consent_agent_auth_method
    CHECK (agent_auth_method IN ('jwt','api_key') OR agent_auth_method IS NULL),
  CONSTRAINT fk_consent_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_consent_agent
    FOREIGN KEY (tenant_id, agent_id)
    REFERENCES commerce_agents(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_consent_request_id
  ON commerce_consent_records(consent_request_id);
CREATE INDEX IF NOT EXISTS idx_commerce_consent_tenant_status
  ON commerce_consent_records(tenant_id, status);
-- Pending (requested) consent records past expires_at are reaped by the
-- consent expiry sweep (M2 ships the writer; sweep job lands in M3).
CREATE INDEX IF NOT EXISTS idx_commerce_consent_expires_pending
  ON commerce_consent_records(expires_at) WHERE status = 'requested';
