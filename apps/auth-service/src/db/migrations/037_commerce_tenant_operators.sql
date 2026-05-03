-- Grantex Commerce V1 — Milestone 2: tenant operator model.
-- Decision C (hybrid):
--   1. Platform/admin key (ADMIN_API_KEY) can create commerce tenants.
--   2. commerce_tenant_operators.role='owner' can manage/bind developers
--      only within tenants they own.
--   3. A tenant owner cannot create arbitrary new unrelated tenants
--      unless they ALSO present the admin key.
--
-- Backfill: any developer with a default commerce_developer_tenants
-- mapping (created during M1, including the auto-provision sandbox path)
-- becomes an owner of that tenant. Without this, M1 sandbox developers
-- would lose access to their own data the moment M2 ships.

CREATE TABLE IF NOT EXISTS commerce_tenant_operators (
  developer_id  TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL REFERENCES commerce_tenants(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (developer_id, tenant_id),
  CONSTRAINT chk_commerce_tenant_operators_role
    CHECK (role IN ('owner','operator'))
);

CREATE INDEX IF NOT EXISTS idx_commerce_tenant_operators_tenant
  ON commerce_tenant_operators(tenant_id);

INSERT INTO commerce_tenant_operators (developer_id, tenant_id, role)
SELECT developer_id, tenant_id, 'owner'
  FROM commerce_developer_tenants
  WHERE is_default = TRUE
ON CONFLICT (developer_id, tenant_id) DO NOTHING;
