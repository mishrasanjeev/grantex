-- Grantex Commerce V1 - Milestone 4E: payment reconciliation metadata.
-- Provider polling records safe status/error details only; raw provider
-- responses and secrets are never stored.

ALTER TABLE commerce_payment_intents
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_error TEXT,
  ADD COLUMN IF NOT EXISTS last_reconciliation_retryable BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_payment_intents_pending_reconciliation
  ON commerce_payment_intents(provider, provider_environment, updated_at)
  WHERE status = 'payment_pending';

CREATE INDEX IF NOT EXISTS idx_payment_intents_reconciled_at
  ON commerce_payment_intents(tenant_id, merchant_id, reconciled_at DESC)
  WHERE reconciled_at IS NOT NULL;
