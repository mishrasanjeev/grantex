-- Decision grants (PRD G-3). A decision grant is a second credential that a
-- named, step-up authenticated person mints for one semantic action on one
-- case. Additive and safe on a live database: new tables only (CREATE ...
-- IF NOT EXISTS), no change to existing tables, rows or tokens. Numbered 098
-- after 096_platform_signing_keys.sql and 097_grant_actor_chain.sql; no table
-- here depends on them.

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
-- ({case_id, action, decision, subject, amount?}) and `action_hash` its RFC 8785
-- hash (spec/canonicalization.md).
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
  policy_score_ref    TEXT,
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

-- A step-up authenticated approver session, created from an ID token of one
-- of the developer's active OIDC SSO connections. Each ID token is exchanged
-- once (id_token_hash).
CREATE TABLE IF NOT EXISTS decision_approver_sessions (
  id              TEXT PRIMARY KEY,
  developer_id    TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  connection_id   TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  email           TEXT,
  name            TEXT,
  acr             TEXT,
  amr             TEXT[] NOT NULL DEFAULT '{}',
  approver_auth   TEXT NOT NULL,
  auth_time       TIMESTAMPTZ NOT NULL,
  id_token_hash   TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS decision_approver_sessions_developer_idx
  ON decision_approver_sessions (developer_id, created_at);

-- Minted decision grants. `jti` is single use: consumed_at is set exactly once
-- by an atomic UPDATE ... WHERE consumed_at IS NULL. For a four-eyes request the
-- second grant references the first (first_jti) and must have another subject.
CREATE TABLE IF NOT EXISTS decision_grants (
  jti                 TEXT PRIMARY KEY,
  developer_id        TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  request_id          TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
  session_id          TEXT NOT NULL REFERENCES decision_approver_sessions(id),
  approver_sub        TEXT NOT NULL,
  approver_auth       TEXT NOT NULL,
  dwell_ms            INTEGER NOT NULL CHECK (dwell_ms >= 0),
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

-- One-time links that open the server-rendered approval page for an approver
-- session. Only the SHA-256 of the ticket is stored.
CREATE TABLE IF NOT EXISTS decision_page_tickets (
  ticket_hash   TEXT PRIMARY KEY,
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  request_id    TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES decision_approver_sessions(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ
);

-- When the approval page was rendered to a session, so dwell time is measured
-- by the server from render to submit.
CREATE TABLE IF NOT EXISTS decision_page_views (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES decision_requests(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES decision_approver_sessions(id) ON DELETE CASCADE,
  rendered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at  TIMESTAMPTZ
);
