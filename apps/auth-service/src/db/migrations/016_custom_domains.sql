-- Custom domains for Enterprise developers
CREATE TABLE IF NOT EXISTS custom_domains (
  id                  TEXT PRIMARY KEY,
  developer_id        TEXT NOT NULL REFERENCES developers(id),
  domain              TEXT NOT NULL UNIQUE,
  verification_token  TEXT NOT NULL,
  verified            BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_developer ON custom_domains(developer_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain);
