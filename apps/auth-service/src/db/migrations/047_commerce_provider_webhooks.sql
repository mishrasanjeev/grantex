-- Grantex Commerce V1 - Milestone 4D: provider webhook event intake.
-- Store safe payload hashes and processing outcomes. Raw provider payloads
-- are not stored in Postgres; raw_payload_ref remains available for a future
-- redacted object-store reference if operations need it.

CREATE TABLE IF NOT EXISTS commerce_provider_webhook_events (
  id                              TEXT PRIMARY KEY, -- cwh_<ulid>
  tenant_id                       TEXT REFERENCES commerce_tenants(id),
  source_type                     TEXT NOT NULL DEFAULT 'provider',
  source_key                      TEXT NOT NULL,
  provider_key                    TEXT NOT NULL,
  merchant_id                     TEXT,
  payment_intent_id               TEXT,
  provider_payment_id             TEXT,
  merchant_ref                    TEXT,
  provider_event_id               TEXT NOT NULL,
  provider_event_type             TEXT NOT NULL,
  signature_validation_status     TEXT NOT NULL,
  replay_status                   TEXT NOT NULL DEFAULT 'fresh',
  processing_status               TEXT NOT NULL DEFAULT 'received',
  payload_hash                    TEXT NOT NULL,
  raw_payload_ref                 TEXT,
  provider_metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code                      TEXT,
  error_message                   TEXT,
  attempt_count                   INTEGER NOT NULL DEFAULT 1,
  received_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at                    TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_provider_webhook_source_type
    CHECK (source_type IN ('provider')),
  CONSTRAINT chk_provider_webhook_signature_status
    CHECK (signature_validation_status IN ('valid','invalid','blocked')),
  CONSTRAINT chk_provider_webhook_replay_status
    CHECK (replay_status IN ('fresh','duplicate','stale')),
  CONSTRAINT chk_provider_webhook_processing_status
    CHECK (processing_status IN ('received','processed','ignored','failed')),
  CONSTRAINT chk_provider_webhook_attempt_count
    CHECK (attempt_count >= 1),
  CONSTRAINT fk_provider_webhook_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_webhook_provider_event
  ON commerce_provider_webhook_events(provider_key, provider_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_webhook_source_event
  ON commerce_provider_webhook_events(tenant_id, source_type, source_key, provider_event_id)
  WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_webhook_payment_reference
  ON commerce_provider_webhook_events(provider_key, provider_payment_id, merchant_ref);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_tenant_merchant_received
  ON commerce_provider_webhook_events(tenant_id, merchant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_processing_status
  ON commerce_provider_webhook_events(processing_status, received_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_provider_webhook_events TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_provider_webhook_events FROM grantex_app';
  END IF;
END
$$;
