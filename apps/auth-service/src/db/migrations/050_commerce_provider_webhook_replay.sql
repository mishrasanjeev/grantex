-- Grantex Commerce V1 - Milestone 14: safe provider webhook replay storage.
-- Replay is only possible for future provider webhook events that passed
-- original provider signature verification. Raw payload material is stored
-- encrypted with vault-crypto AES-256-GCM and is never returned by APIs.

CREATE TABLE IF NOT EXISTS commerce_provider_webhook_event_payloads (
  tenant_id           TEXT NOT NULL REFERENCES commerce_tenants(id),
  webhook_event_id    TEXT NOT NULL REFERENCES commerce_provider_webhook_events(id),
  provider_key        TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  encrypted_payload   TEXT NOT NULL,
  safe_headers_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, webhook_event_id),
  CONSTRAINT uq_provider_webhook_event_payload
    UNIQUE (webhook_event_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_webhook_payloads_provider
  ON commerce_provider_webhook_event_payloads(tenant_id, provider_key, created_at DESC);

ALTER TABLE commerce_provider_webhook_events
  ADD COLUMN IF NOT EXISTS replay_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_replayed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT INSERT, SELECT ON commerce_provider_webhook_event_payloads TO grantex_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_provider_webhook_event_payloads FROM grantex_app';
    EXECUTE 'GRANT UPDATE (replay_count, last_replayed_at, processing_status, error_code, error_message, processed_at, updated_at, attempt_count) ON commerce_provider_webhook_events TO grantex_app';
  END IF;
END
$$;
