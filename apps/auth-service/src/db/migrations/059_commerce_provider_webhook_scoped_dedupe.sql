-- Scope provider webhook idempotency to the matched tenant/payment context.
-- Provider event ids are not safe as a global namespace across merchants.

DROP INDEX IF EXISTS uq_provider_webhook_provider_event;
DROP INDEX IF EXISTS uq_provider_webhook_source_event;

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_webhook_tenant_merchant_event
  ON commerce_provider_webhook_events(tenant_id, provider_key, merchant_id, provider_event_id)
  WHERE tenant_id IS NOT NULL AND merchant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_webhook_tenant_payment_event
  ON commerce_provider_webhook_events(tenant_id, provider_key, provider_payment_id, provider_event_id)
  WHERE tenant_id IS NOT NULL AND provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_webhook_tenant_unknown_event
  ON commerce_provider_webhook_events(tenant_id, source_type, source_key, provider_event_id, payload_hash)
  WHERE tenant_id IS NOT NULL AND merchant_id IS NULL AND provider_payment_id IS NULL;
