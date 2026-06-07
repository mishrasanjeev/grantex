-- Grantex Commerce V1 - C6N: existing-system connector registry foundation.
-- Registry rows are metadata-only. They do not store credentials, do not
-- enable provider calls, and do not allow AgenticOrg or agents to execute
-- merchant private-system actions directly.
-- Source domains are catalog, price, inventory, order, fulfillment, refund,
-- settlement, and support; route validation enforces this list.

CREATE TABLE IF NOT EXISTS commerce_connectors (
  id                                  TEXT PRIMARY KEY, -- cconn_<ulid>
  tenant_id                           TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id                         TEXT NOT NULL,
  connector_key                       TEXT NOT NULL,
  connector_type                      TEXT NOT NULL,
  display_name                        TEXT NOT NULL,
  status                              TEXT NOT NULL DEFAULT 'draft',
  runtime_mode                        TEXT NOT NULL DEFAULT 'metadata_only',
  source_domains                      JSONB NOT NULL DEFAULT '[]'::JSONB,
  source_priority                     INTEGER NOT NULL DEFAULT 100,
  sync_status                         TEXT NOT NULL DEFAULT 'not_started',
  health_state                        TEXT NOT NULL DEFAULT 'unknown',
  last_sync_at                        TIMESTAMPTZ,
  last_successful_sync_at             TIMESTAMPTZ,
  stale_after_seconds                 INTEGER NOT NULL DEFAULT 86400,
  conflict_blockers                   JSONB NOT NULL DEFAULT '[]'::JSONB,
  webhook_source_key                  TEXT,
  agenticorg_direct_execution_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  provider_call_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  stores_credentials                  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_commerce_connectors_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT uq_commerce_connectors_key UNIQUE (tenant_id, merchant_id, connector_key),
  CONSTRAINT fk_commerce_connectors_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_commerce_connectors_webhook_source
    FOREIGN KEY (tenant_id, merchant_id, webhook_source_key)
    REFERENCES commerce_webhook_sources(tenant_id, merchant_id, source_key),
  CONSTRAINT chk_commerce_connector_type CHECK (
    connector_type IN (
      'manual',
      'csv',
      'custom_api',
      'shopify',
      'woocommerce',
      'magento',
      'erp',
      'billing',
      'oms',
      'wms',
      'logistics',
      'crm_support',
      'payment_provider'
    )
  ),
  CONSTRAINT chk_commerce_connector_status
    CHECK (status IN ('draft','active','disabled')),
  CONSTRAINT chk_commerce_connector_runtime_mode
    CHECK (runtime_mode IN (
      'metadata_only',
      'manual_catalog_api',
      'csv_catalog_import',
      'custom_api_declared'
    )),
  CONSTRAINT chk_commerce_connector_sync_status
    CHECK (sync_status IN (
      'not_started',
      'manual',
      'scheduled',
      'sync_succeeded',
      'sync_failed',
      'blocked'
    )),
  CONSTRAINT chk_commerce_connector_health_state
    CHECK (health_state IN ('unknown','healthy','stale','conflict','blocked','disabled')),
  CONSTRAINT chk_commerce_connector_priority_nonnegative
    CHECK (source_priority >= 0),
  CONSTRAINT chk_commerce_connector_stale_after
    CHECK (stale_after_seconds BETWEEN 0 AND 31536000),
  CONSTRAINT chk_commerce_connector_no_execution_or_secret_storage CHECK (
    agenticorg_direct_execution_enabled = FALSE
    AND provider_call_enabled = FALSE
    AND stores_credentials = FALSE
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_connectors_merchant
  ON commerce_connectors(tenant_id, merchant_id, source_priority, connector_key);

CREATE INDEX IF NOT EXISTS idx_commerce_connectors_type
  ON commerce_connectors(tenant_id, merchant_id, connector_type);

CREATE INDEX IF NOT EXISTS idx_commerce_connectors_health
  ON commerce_connectors(tenant_id, merchant_id, health_state, sync_status);

CREATE INDEX IF NOT EXISTS idx_commerce_connectors_source_domains
  ON commerce_connectors USING GIN (source_domains);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_connectors TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_connectors FROM grantex_app';
  END IF;
END
$$;
