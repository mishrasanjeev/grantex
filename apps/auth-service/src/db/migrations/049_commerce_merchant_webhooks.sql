-- Grantex Commerce V1 - M12C: merchant catalog webhook sources and events.
-- Source secrets are encrypted for verification and hashed for forensic
-- reference. Raw merchant webhook payloads and raw signatures are not stored.

CREATE TABLE IF NOT EXISTS commerce_webhook_sources (
  tenant_id               TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id             TEXT NOT NULL,
  source_key              TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active',
  secret_hash             TEXT NOT NULL,
  encrypted_secret        TEXT NOT NULL,
  secret_last_rotated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, merchant_id, source_key),
  CONSTRAINT chk_commerce_webhook_source_status
    CHECK (status IN ('active','disabled')),
  CONSTRAINT fk_commerce_webhook_source_merchant
    FOREIGN KEY (tenant_id, merchant_id)
    REFERENCES commerce_merchants(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_webhook_sources_merchant
  ON commerce_webhook_sources(tenant_id, merchant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_commerce_webhook_sources_status
  ON commerce_webhook_sources(tenant_id, merchant_id, status);

CREATE TABLE IF NOT EXISTS commerce_merchant_webhook_events (
  id                              TEXT PRIMARY KEY, -- cwh_<ulid>
  tenant_id                       TEXT NOT NULL REFERENCES commerce_tenants(id),
  merchant_id                     TEXT NOT NULL,
  source_key                      TEXT NOT NULL,
  provider_event_id               TEXT NOT NULL,
  event_type                      TEXT NOT NULL,
  payload_hash                    TEXT NOT NULL,
  signature_validation_status     TEXT NOT NULL,
  replay_status                   TEXT NOT NULL DEFAULT 'fresh',
  processing_status               TEXT NOT NULL DEFAULT 'received',
  processing_error                TEXT,
  occurred_at                     TIMESTAMPTZ,
  received_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at                    TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_merchant_webhook_signature_status
    CHECK (signature_validation_status IN ('valid','invalid','blocked')),
  CONSTRAINT chk_merchant_webhook_replay_status
    CHECK (replay_status IN ('fresh','duplicate','stale')),
  CONSTRAINT chk_merchant_webhook_processing_status
    CHECK (processing_status IN ('received','processed','duplicate','ignored','failed')),
  CONSTRAINT fk_merchant_webhook_source
    FOREIGN KEY (tenant_id, merchant_id, source_key)
    REFERENCES commerce_webhook_sources(tenant_id, merchant_id, source_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_webhook_source_event
  ON commerce_merchant_webhook_events(tenant_id, merchant_id, source_key, provider_event_id);

CREATE INDEX IF NOT EXISTS idx_merchant_webhook_events_merchant_received
  ON commerce_merchant_webhook_events(tenant_id, merchant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_merchant_webhook_events_status
  ON commerce_merchant_webhook_events(tenant_id, merchant_id, processing_status, received_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_webhook_sources TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_webhook_sources FROM grantex_app';
    EXECUTE 'GRANT INSERT, SELECT, UPDATE ON commerce_merchant_webhook_events TO grantex_app';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON commerce_merchant_webhook_events FROM grantex_app';
  END IF;
END
$$;
