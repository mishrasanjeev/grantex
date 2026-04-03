-- Expand trust_registry with richer org profile
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS developer_id TEXT REFERENCES developers(id);
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS badges TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS public_keys JSONB NOT NULL DEFAULT '[]';
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS contact_security TEXT;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS contact_dpo TEXT;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS compliance_soc2 BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS compliance_iso27001 BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS compliance_dpdp BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS compliance_gdpr BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS total_agents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS weekly_active_grants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS average_rating NUMERIC(3,2) NOT NULL DEFAULT 0;
ALTER TABLE trust_registry ADD COLUMN IF NOT EXISTS review_count INTEGER NOT NULL DEFAULT 0;

-- Registered agents within an org
CREATE TABLE IF NOT EXISTS registry_agents (
  id                TEXT PRIMARY KEY,
  registry_id       TEXT NOT NULL REFERENCES trust_registry(id),
  agent_id          TEXT REFERENCES agents(id),
  agent_did         TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  version           TEXT,
  scopes            TEXT[] NOT NULL DEFAULT '{}',
  category          TEXT NOT NULL DEFAULT 'other',
  npm_package       TEXT,
  pypi_package      TEXT,
  github_url        TEXT,
  weekly_active_grants INTEGER NOT NULL DEFAULT 0,
  rating            NUMERIC(3,2) NOT NULL DEFAULT 0,
  review_count      INTEGER NOT NULL DEFAULT 0,
  listed            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registry_agents_registry ON registry_agents(registry_id);
CREATE INDEX IF NOT EXISTS idx_registry_agents_listed ON registry_agents(listed);
