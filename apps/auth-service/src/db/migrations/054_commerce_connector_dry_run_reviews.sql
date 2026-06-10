-- Grantex Commerce V1 - C6Sa: sandbox connector dry-run review metadata.
-- Review rows are tenant-scoped and evidence-only. They store redacted
-- summaries, operator decisions, and audit references. They do not approve
-- production launch, enable public discovery, write allowlists, create
-- checkout/payment objects, call providers, call merchant systems, or store
-- credentials, provider metadata, raw files, or private payloads.

CREATE TABLE IF NOT EXISTS commerce_connector_dry_run_reviews (
  id                              TEXT PRIMARY KEY, -- cdrev_<ulid>
  tenant_id                       TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id                     TEXT NOT NULL,
  dry_run_id                      TEXT NOT NULL,
  status                          TEXT NOT NULL DEFAULT 'pending_operator_review',
  decision                        TEXT,
  decision_note                   TEXT,
  requested_by_kind               TEXT NOT NULL,
  requested_by_id                 TEXT NOT NULL,
  decided_by_operator_id          TEXT,
  dry_run_status                  TEXT NOT NULL,
  dry_run_generated_at            TIMESTAMPTZ NOT NULL,
  evidence_summary                JSONB NOT NULL DEFAULT '{}'::JSONB,
  requested_audit_event_id        TEXT NOT NULL REFERENCES commerce_audit_events(id),
  decision_audit_event_id         TEXT REFERENCES commerce_audit_events(id),
  sandbox_only                    BOOLEAN NOT NULL DEFAULT TRUE,
  not_live                        BOOLEAN NOT NULL DEFAULT TRUE,
  not_approved                    BOOLEAN NOT NULL DEFAULT TRUE,
  public_discovery_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  checkout_payment_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  live_provider_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
  provider_specific_live_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  production_allowlist_written    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at                      TIMESTAMPTZ,
  CONSTRAINT uq_commerce_connector_dry_run_reviews_tenant_dry_run UNIQUE (tenant_id, dry_run_id),
  CONSTRAINT fk_commerce_connector_dry_run_reviews_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_commerce_connector_dry_run_reviews_dry_run
    FOREIGN KEY (tenant_id, dry_run_id)
    REFERENCES commerce_connector_dry_runs(tenant_id, id),
  CONSTRAINT chk_commerce_connector_dry_run_reviews_status
    CHECK (status IN ('pending_operator_review','accepted_for_sandbox_followup','needs_changes','blocked')),
  CONSTRAINT chk_commerce_connector_dry_run_reviews_decision
    CHECK (decision IS NULL OR decision IN ('accepted_for_sandbox_followup','needs_changes','blocked')),
  CONSTRAINT chk_commerce_connector_dry_run_reviews_actor_kind
    CHECK (requested_by_kind IN ('operator','merchant')),
  CONSTRAINT chk_commerce_connector_dry_run_reviews_decision_shape CHECK (
    (status = 'pending_operator_review'
      AND decision IS NULL
      AND decided_by_operator_id IS NULL
      AND decision_audit_event_id IS NULL
      AND decided_at IS NULL)
    OR
    (status <> 'pending_operator_review'
      AND decision = status
      AND decided_by_operator_id IS NOT NULL
      AND decision_audit_event_id IS NOT NULL
      AND decided_at IS NOT NULL)
  ),
  CONSTRAINT chk_commerce_connector_dry_run_reviews_non_enabling CHECK (
    sandbox_only = TRUE
    AND not_live = TRUE
    AND not_approved = TRUE
    AND public_discovery_enabled = FALSE
    AND checkout_payment_enabled = FALSE
    AND live_provider_enabled = FALSE
    AND provider_specific_live_enabled = FALSE
    AND production_allowlist_written = FALSE
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_run_reviews_merchant
  ON commerce_connector_dry_run_reviews(tenant_id, merchant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_run_reviews_status
  ON commerce_connector_dry_run_reviews(tenant_id, merchant_id, status, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_connector_dry_run_reviews TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_connector_dry_run_reviews FROM grantex_app';
  END IF;
END
$$;
