-- Grantex Commerce V1 — Milestone 2 (P0 fix): consent challenge.
--
-- Background: developer-minted principal sessions are issued by
-- POST /v1/principal-sessions and authenticate the developer's view of
-- "who the user is". A trusted agent / its developer can therefore mint
-- a session for any of their principals (anyone with an active grant)
-- and bypass user consent end-to-end:
--   1. Agent creates a consent request.
--   2. Developer mints a principal session JWT for the hinted principal.
--   3. Agent uses ?session= bootstrap, the cookie is set.
--   4. Agent computes csrf = sha256(session_token + ':' + reqId).
--   5. Agent POSTs approve.  No human is in the loop.
--
-- This table records a SECOND, server-issued, single-use credential —
-- the "consent challenge" — which the agent/developer cannot read,
-- mint, or compute. Approve/deny require a verified challenge for the
-- same (consent_request_id, principal_id) pair, consumed atomically
-- with the status transition.
--
-- Code is never stored in plaintext. challenge_hash is sha256(code +
-- ':' + consent_request_id + ':' + principal_id) — domain-separated so
-- a hash leak from one consent cannot be replayed against another.

CREATE TABLE IF NOT EXISTS commerce_consent_challenges (
  id                    TEXT PRIMARY KEY,                                       -- ccch_<ulid>
  tenant_id             TEXT NOT NULL REFERENCES commerce_tenants(id),
  consent_record_id     TEXT NOT NULL REFERENCES commerce_consent_records(id),
  consent_request_id    TEXT NOT NULL,
  principal_id          TEXT NOT NULL,
  developer_id          TEXT NOT NULL,                                          -- the developer of the session that requested the challenge
  challenge_hash        TEXT NOT NULL,                                          -- sha256(code:reqId:principalId)
  delivery_channel      TEXT NOT NULL,                                          -- test_sink | email_otp
  status                TEXT NOT NULL DEFAULT 'requested',                      -- requested | verified | used | expired
  attempts_count        INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  expires_at            TIMESTAMPTZ NOT NULL,
  verified_at           TIMESTAMPTZ,
  used_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_consent_challenge_status
    CHECK (status IN ('requested','verified','used','expired')),
  CONSTRAINT chk_consent_challenge_delivery
    CHECK (delivery_channel IN ('test_sink','email_otp'))
);

-- Only ONE active (requested|verified) challenge per consent_request_id +
-- principal_id at a time. Forces explicit rotation; prevents an agent
-- from spamming many parallel challenges to brute-force codes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_consent_challenges_active
  ON commerce_consent_challenges(consent_request_id, principal_id)
  WHERE status IN ('requested','verified');

CREATE INDEX IF NOT EXISTS idx_commerce_consent_challenges_request
  ON commerce_consent_challenges(consent_request_id);
CREATE INDEX IF NOT EXISTS idx_commerce_consent_challenges_expires
  ON commerce_consent_challenges(expires_at)
  WHERE status IN ('requested','verified');
CREATE INDEX IF NOT EXISTS idx_commerce_consent_challenges_consent_record
  ON commerce_consent_challenges(consent_record_id);
