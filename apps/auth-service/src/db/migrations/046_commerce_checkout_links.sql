-- Grantex Commerce V1 - Milestone 4C: checkout link persistence.
-- Checkout link creation updates the existing provider-neutral payment
-- intent row; provider webhooks and reconciliation remain deferred.

ALTER TABLE commerce_payment_intents
  ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_payment_intents_checkout_expires
  ON commerce_payment_intents(tenant_id, merchant_id, checkout_expires_at)
  WHERE checkout_expires_at IS NOT NULL;
