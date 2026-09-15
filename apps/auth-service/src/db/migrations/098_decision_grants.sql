-- Decision grants (PRD G-3). A decision grant is a second credential that a
-- named, step-up authenticated person mints for one semantic action on one
-- case. Additive and safe on a live database: new tables only (CREATE ...
-- IF NOT EXISTS), no change to existing tables, rows or tokens. Numbered 098
-- after 096_platform_signing_keys.sql and 097_grant_actor_chain.sql; no table
-- here depends on them.

-- Identity providers whose users may approve decisions for a developer. Kept
-- apart from sso_connections: only the service administrator can add one, so
-- a developer API key cannot introduce an identity provider it controls.
CREATE TABLE IF NOT EXISTS decision_approver_idps (
  id                        TEXT PRIMARY KEY,
  developer_id              TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  issuer                    TEXT NOT NULL,
  client_id                 TEXT NOT NULL,
  client_secret_encrypted   TEXT,
  acr_values                TEXT[] NOT NULL DEFAULT '{}',
  require_verified_email    BOOLEAN NOT NULL DEFAULT FALSE,
  display_name              TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by                TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS decision_approver_idps_client_uniq
  ON decision_approver_idps (developer_id, issuer, client_id);

-- Current version (an opaque fingerprint chosen by the platform) of every case
-- a decision was requested for. Registering a new version supersedes open
-- requests and revokes unconsumed decision grants minted for another version.
CREATE TABLE IF NOT EXISTS decision_cases (
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  case_id       TEXT NOT NULL,
  case_version  TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, case_id)
);

-- A decision a platform asks a person to take. `action` is the semantic action
-- and `action_hash` its RFC 8785 hash (spec/canonicalization.md). The memo and
-- policy score are stored as supplied, with their hashes, and shown verbatim.
CREATE TABLE IF NOT EXISTS decision_requests (
  id                  TEXT PRIMARY KEY,
  developer_id        TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  case_id             TEXT NOT NULL,
  case_version        TEXT NOT NULL,
  connector           TEXT NOT NULL,
  action              JSONB NOT NULL,
  action_hash         TEXT NOT NULL,
  approvals_required  SMALLINT NOT NULL CHECK (approvals_required IN (1, 2)),
  memo_ref            TEXT,
  memo_content        TEXT NOT NULL,
  memo_hash           TEXT NOT NULL,
  policy_score_ref    TEXT,
  policy_score        JSONB NOT NULL,
  policy_score_hash   TEXT NOT NULL,
  agent_id            TEXT,
  grant_id            TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'consumed', 'superseded', 'cancelled')),
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS decision_requests_case_idx
  ON decision_requests (developer_id, case_id, status);

-- At most one open request per action on one case version.
CREATE UNIQUE INDEX IF NOT EXISTS decision_requests_open_action_uniq
  ON decision_requests (developer_id, action_hash, case_version)
  WHERE status IN ('pending', 'approved');

-- A browser sign-in in progress (authorization code flow with PKCE). The state
-- is single use; the nonce and PKCE verifier never leave the service; the
-- browser that started the sign-in must present the binding cookie.
CREATE TABLE IF NOT EXISTS decision_login_states (
  state_hash               TEXT PRIMARY KEY,
  developer_id             TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  idp_id                   TEXT NOT NULL REFERENCES decision_approver_idps(id) ON DELETE CASCADE,
  request_id               TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
  nonce                    TEXT NOT NULL,
  code_verifier_encrypted  TEXT NOT NULL,
  browser_binding_hash     TEXT NOT NULL,
  expires_at               TIMESTAMPTZ NOT NULL,
  used_at                  TIMESTAMPTZ
);

-- A step-up authenticated approver session in one browser. Only the SHA-256 of
-- the session secret is stored; the secret lives in an HttpOnly cookie on the
-- service's origin. Email is kept as a keyed hash and the name encrypted.
CREATE TABLE IF NOT EXISTS decision_approver_sessions (
  id                   TEXT PRIMARY KEY,
  developer_id         TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  idp_id               TEXT NOT NULL REFERENCES decision_approver_idps(id),
  issuer               TEXT NOT NULL,
  idp_subject          TEXT NOT NULL,
  subject              TEXT NOT NULL,
  email_hash           TEXT,
  name_encrypted       TEXT,
  acr                  TEXT,
  amr                  TEXT[] NOT NULL DEFAULT '{}',
  approver_auth        TEXT NOT NULL,
  auth_time            TIMESTAMPTZ NOT NULL,
  nonce                TEXT NOT NULL,
  session_secret_hash  TEXT NOT NULL UNIQUE,
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An ID token nonce is accepted once per issuer and subject.
CREATE UNIQUE INDEX IF NOT EXISTS decision_approver_sessions_nonce_uniq
  ON decision_approver_sessions (issuer, idp_subject, nonce);

-- Minted decision grants. `jti` is single use: consumed_at is set exactly once
-- by an atomic UPDATE ... WHERE consumed_at IS NULL. For a four-eyes request the
-- second grant references the first (first_jti) and must have another subject.
CREATE TABLE IF NOT EXISTS decision_grants (
  jti                 TEXT PRIMARY KEY,
  developer_id        TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  request_id          TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL REFERENCES decision_approver_sessions(id),
  approver_sub        TEXT NOT NULL,
  approver_email_hash TEXT,
  approver_auth       TEXT NOT NULL,
  dwell_ms            INTEGER NOT NULL CHECK (dwell_ms >= 0),
  dwell_source        TEXT NOT NULL CHECK (dwell_source IN ('server')),
  case_id             TEXT NOT NULL,
  case_version        TEXT NOT NULL,
  action_hash         TEXT NOT NULL,
  approval_position   SMALLINT NOT NULL CHECK (approval_position IN (1, 2)),
  first_jti           TEXT REFERENCES decision_grants(jti),
  claims              JSONB NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_reason      TEXT,
  UNIQUE (request_id, approver_sub),
  UNIQUE (request_id, approval_position)
);

CREATE INDEX IF NOT EXISTS decision_grants_case_idx
  ON decision_grants (developer_id, case_id) WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- When the approval page was rendered to a session: dwell time is measured by
-- the service from rendering to submission, from these timestamps only.
CREATE TABLE IF NOT EXISTS decision_page_views (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES decision_approver_sessions(id) ON DELETE CASCADE,
  rendered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at  TIMESTAMPTZ
);
