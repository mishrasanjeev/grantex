-- Grantex Commerce V1 — Milestone 1: tenant model.
-- Per architecture decision (project-grantex-commerce.md), tenancy uses a
-- dedicated commerce_tenants table with a many-to-one developer→tenant
-- mapping, NOT an alias of developers.id. This lets the Pine/Plural partner
-- own a dedicated tenant later without retrofitting every commerce table.

CREATE TABLE IF NOT EXISTS commerce_tenants (
  id            TEXT PRIMARY KEY,                         -- cten_<ulid>
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',           -- active | disabled
  metadata      JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_commerce_tenants_status CHECK (status IN ('active','disabled'))
);

-- Many-to-one developer→tenant mapping. A developer can be associated with
-- one or more tenants; M1 auto-creates a single tenant per developer on
-- first commerce access. Multi-tenant-per-developer becomes meaningful in
-- M2+ when partner/operator distinctions land.
CREATE TABLE IF NOT EXISTS commerce_developer_tenants (
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL REFERENCES commerce_tenants(id) ON DELETE CASCADE,
  is_default    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_dev_tenants_developer
  ON commerce_developer_tenants(developer_id);
CREATE INDEX IF NOT EXISTS idx_commerce_dev_tenants_tenant
  ON commerce_developer_tenants(tenant_id);

-- Exactly one default tenant per developer. Future PATCH endpoints can
-- shift the default; this constraint stops "two defaults" drift.
CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_dev_tenants_default
  ON commerce_developer_tenants(developer_id) WHERE is_default = TRUE;
