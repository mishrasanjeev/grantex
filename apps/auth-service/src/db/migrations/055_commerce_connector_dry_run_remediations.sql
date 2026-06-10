-- Grantex Commerce V1 - C6Sg: sandbox connector dry-run remediation evidence.
-- Remediation rows are tenant-scoped and redacted. They link an original
-- needs_changes/blocked connector review to a corrected sandbox dry-run and
-- optional follow-up review. They do not store raw connector files, raw
-- merchant-system payloads, credentials, provider metadata, production config,
-- allowlists, checkout URLs, payment identifiers, or live execution state.

CREATE TABLE IF NOT EXISTS commerce_connector_dry_run_remediations (
  id                                TEXT PRIMARY KEY, -- cdrem_<ulid>
  tenant_id                         TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id                       TEXT NOT NULL,
  original_dry_run_id               TEXT NOT NULL,
  original_review_id                TEXT NOT NULL REFERENCES commerce_connector_dry_run_reviews(id),
  original_decision                 TEXT NOT NULL,
  status                            TEXT NOT NULL DEFAULT 'remediation_requested',
  public_safe_note                  TEXT,
  blocker_summary                   JSONB NOT NULL DEFAULT '[]'::JSONB,
  warning_summary                   JSONB NOT NULL DEFAULT '[]'::JSONB,
  corrected_dry_run_id              TEXT,
  followup_review_id                TEXT REFERENCES commerce_connector_dry_run_reviews(id),
  requested_by_kind                 TEXT NOT NULL,
  requested_by_id                   TEXT NOT NULL,
  requested_audit_event_id          TEXT NOT NULL REFERENCES commerce_audit_events(id),
  corrected_audit_event_id          TEXT REFERENCES commerce_audit_events(id),
  followup_audit_event_id           TEXT REFERENCES commerce_audit_events(id),
  closed_or_blocked_audit_event_id  TEXT REFERENCES commerce_audit_events(id),
  sandbox_only                      BOOLEAN NOT NULL DEFAULT TRUE,
  not_live                          BOOLEAN NOT NULL DEFAULT TRUE,
  not_approved                      BOOLEAN NOT NULL DEFAULT TRUE,
  public_discovery_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  checkout_payment_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  live_provider_enabled             BOOLEAN NOT NULL DEFAULT FALSE,
  provider_specific_live_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  production_allowlist_written      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_commerce_connector_dry_run_remediations_original
    UNIQUE (tenant_id, original_dry_run_id, original_review_id),
  CONSTRAINT fk_commerce_connector_dry_run_remediations_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id),
  CONSTRAINT fk_commerce_connector_dry_run_remediations_original_dry_run
    FOREIGN KEY (tenant_id, original_dry_run_id)
    REFERENCES commerce_connector_dry_runs(tenant_id, id),
  CONSTRAINT fk_commerce_connector_dry_run_remediations_corrected_dry_run
    FOREIGN KEY (tenant_id, corrected_dry_run_id)
    REFERENCES commerce_connector_dry_runs(tenant_id, id),
  CONSTRAINT chk_commerce_connector_dry_run_remediations_original_decision
    CHECK (original_decision IN ('needs_changes','blocked')),
  CONSTRAINT chk_commerce_connector_dry_run_remediations_actor_kind
    CHECK (requested_by_kind IN ('operator','merchant')),
  CONSTRAINT chk_commerce_connector_dry_run_remediations_status
    CHECK (status IN (
      'remediation_requested',
      'waiting_for_corrected_dry_run',
      'corrected_dry_run_attached',
      'followup_review_requested',
      'followup_ready',
      'blocked_again',
      'closed_no_action'
    )),
  CONSTRAINT chk_commerce_connector_dry_run_remediations_non_enabling CHECK (
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

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_run_remediations_merchant
  ON commerce_connector_dry_run_remediations(tenant_id, merchant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_run_remediations_status
  ON commerce_connector_dry_run_remediations(tenant_id, merchant_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_connector_dry_run_remediations_corrected
  ON commerce_connector_dry_run_remediations(tenant_id, merchant_id, corrected_dry_run_id)
  WHERE corrected_dry_run_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_connector_dry_run_remediations TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_connector_dry_run_remediations FROM grantex_app';
  END IF;
END
$$;
