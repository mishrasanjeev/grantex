-- Grantex Commerce V1 - C6R: sandbox connector sync dry-run metadata.
-- Dry-run rows are tenant-scoped and redacted. They store safe counts,
-- blockers, warnings, capped normalized preview rows, and audit references
-- only. They do not store raw files, raw merchant-system payloads,
-- credentials, provider metadata, production config, allowlists, checkout
-- URLs, payment identifiers, or live execution state.

CREATE TABLE IF NOT EXISTS commerce_connector_dry_runs (
  id                              TEXT PRIMARY KEY, -- cdry_<ulid>
  tenant_id                       TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id                     TEXT NOT NULL,
  connector_type                  TEXT NOT NULL,
  source_label                    TEXT NOT NULL,
  status                          TEXT NOT NULL,
  sandbox_only                    BOOLEAN NOT NULL DEFAULT TRUE,
  not_live                        BOOLEAN NOT NULL DEFAULT TRUE,
  not_approved                    BOOLEAN NOT NULL DEFAULT TRUE,
  public_discovery_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  checkout_payment_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  live_provider_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  provider_specific_live_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  rows_received                   INTEGER NOT NULL DEFAULT 0,
  products_detected               INTEGER NOT NULL DEFAULT 0,
  variants_detected               INTEGER NOT NULL DEFAULT 0,
  would_create_count              INTEGER NOT NULL DEFAULT 0,
  would_update_count              INTEGER NOT NULL DEFAULT 0,
  would_archive_count             INTEGER NOT NULL DEFAULT 0,
  blocked_count                   INTEGER NOT NULL DEFAULT 0,
  warning_count                   INTEGER NOT NULL DEFAULT 0,
  normalized_preview              JSONB NOT NULL DEFAULT '[]'::JSONB,
  blockers                        JSONB NOT NULL DEFAULT '[]'::JSONB,
  warnings                        JSONB NOT NULL DEFAULT '[]'::JSONB,
  requested_audit_event_id        TEXT NOT NULL REFERENCES commerce_audit_events(id),
  result_audit_event_id           TEXT NOT NULL REFERENCES commerce_audit_events(id),
  generated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_commerce_connector_dry_runs_tenant_id UNIQUE (tenant_id, id),
  CONSTRAINT fk_commerce_connector_dry_runs_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT chk_commerce_connector_dry_run_type
    CHECK (connector_type IN ('manual','csv')),
  CONSTRAINT chk_commerce_connector_dry_run_status
    CHECK (status IN ('passed','blocked')),
  CONSTRAINT chk_commerce_connector_dry_run_counts_nonnegative CHECK (
    rows_received >= 0
    AND products_detected >= 0
    AND variants_detected >= 0
    AND would_create_count >= 0
    AND would_update_count >= 0
    AND would_archive_count >= 0
    AND blocked_count >= 0
    AND warning_count >= 0
  ),
  CONSTRAINT chk_commerce_connector_dry_run_non_enabling CHECK (
    sandbox_only = TRUE
    AND not_live = TRUE
    AND not_approved = TRUE
    AND public_discovery_enabled = FALSE
    AND checkout_payment_enabled = FALSE
    AND live_provider_enabled = FALSE
    AND provider_specific_live_enabled = FALSE
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_runs_merchant
  ON commerce_connector_dry_runs(tenant_id, merchant_id, generated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_runs_status
  ON commerce_connector_dry_runs(tenant_id, merchant_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT ON commerce_connector_dry_runs TO grantex_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_connector_dry_runs FROM grantex_app';
  END IF;
END
$$;
