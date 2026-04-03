-- DPDP Act 2023 & EU AI Act compliance tables

CREATE TABLE IF NOT EXISTS dpdp_consent_records (
  id                  TEXT PRIMARY KEY,           -- crec_<ulid>
  developer_id        TEXT NOT NULL REFERENCES developers(id),
  grant_id            TEXT NOT NULL REFERENCES grants(id),
  data_principal_id   TEXT NOT NULL,
  data_fiduciary_id   TEXT NOT NULL,
  data_fiduciary_name TEXT NOT NULL,
  purposes            JSONB NOT NULL,
  scopes              TEXT[] NOT NULL,
  consent_notice_id   TEXT NOT NULL,
  consent_notice_hash TEXT NOT NULL,
  consent_given_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consent_method      TEXT NOT NULL DEFAULT 'explicit-click',
  processing_expires_at TIMESTAMPTZ NOT NULL,
  retention_until     TIMESTAMPTZ NOT NULL,
  consent_proof       JSONB NOT NULL DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'active',
  withdrawn_at        TIMESTAMPTZ,
  withdrawn_reason    TEXT,
  last_accessed_at    TIMESTAMPTZ,
  access_count        INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dpdp_consent_developer ON dpdp_consent_records(developer_id);
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_principal ON dpdp_consent_records(data_principal_id);
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_grant ON dpdp_consent_records(grant_id);
CREATE INDEX IF NOT EXISTS idx_dpdp_consent_status ON dpdp_consent_records(status);

CREATE TABLE IF NOT EXISTS dpdp_consent_notices (
  id                TEXT PRIMARY KEY,             -- notice_<ulid>
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  notice_id         TEXT NOT NULL,
  language          TEXT NOT NULL DEFAULT 'en',
  version           TEXT NOT NULL,
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  purposes          JSONB NOT NULL DEFAULT '[]',
  data_fiduciary_contact TEXT,
  grievance_officer JSONB,
  content_hash      TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dpdp_notices_id_version ON dpdp_consent_notices(developer_id, notice_id, version);

CREATE TABLE IF NOT EXISTS dpdp_grievances (
  id                TEXT PRIMARY KEY,             -- grv_<ulid>
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  data_principal_id TEXT NOT NULL,
  record_id         TEXT REFERENCES dpdp_consent_records(id),
  type              TEXT NOT NULL,
  description       TEXT NOT NULL,
  evidence          JSONB NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'submitted',
  reference_number  TEXT NOT NULL UNIQUE,
  expected_resolution_by TIMESTAMPTZ NOT NULL,
  resolved_at       TIMESTAMPTZ,
  resolution        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dpdp_grievances_developer ON dpdp_grievances(developer_id);
CREATE INDEX IF NOT EXISTS idx_dpdp_grievances_principal ON dpdp_grievances(data_principal_id);

CREATE TABLE IF NOT EXISTS dpdp_exports (
  id                TEXT PRIMARY KEY,             -- exp_<ulid>
  developer_id      TEXT NOT NULL REFERENCES developers(id),
  type              TEXT NOT NULL,
  date_from         TIMESTAMPTZ NOT NULL,
  date_to           TIMESTAMPTZ NOT NULL,
  format            TEXT NOT NULL DEFAULT 'json',
  status            TEXT NOT NULL DEFAULT 'complete',
  record_count      INTEGER NOT NULL DEFAULT 0,
  data              JSONB,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
