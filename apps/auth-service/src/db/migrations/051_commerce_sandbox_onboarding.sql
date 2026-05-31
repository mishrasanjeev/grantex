-- C5Z: seller self-serve sandbox onboarding foundation.
-- This extends the tenant-owned CommerceMerchant row with public-safe sandbox
-- onboarding fields only. It does not store provider credentials, production
-- allowlist values, checkout/payment state, private approval artifacts, or
-- live-payment material.

ALTER TABLE commerce_merchants
  ADD COLUMN IF NOT EXISTS support_url TEXT,
  ADD COLUMN IF NOT EXISTS public_discovery_description_draft TEXT,
  ADD COLUMN IF NOT EXISTS agentic_commerce_requested BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sandbox_onboarding_state TEXT NOT NULL DEFAULT 'draft_created',
  ADD COLUMN IF NOT EXISTS sandbox_onboarding_blocker TEXT,
  ADD COLUMN IF NOT EXISTS sandbox_onboarding_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_commerce_merchants_sandbox_onboarding_state'
       AND conrelid = 'commerce_merchants'::regclass
  ) THEN
    ALTER TABLE commerce_merchants
      ADD CONSTRAINT chk_commerce_merchants_sandbox_onboarding_state CHECK (
        sandbox_onboarding_state IN (
          'draft_created',
          'profile_incomplete',
          'sandbox_ready',
          'submitted_for_review',
          'blocked',
          'not_approved',
          'rollout_not_requested'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_commerce_merchants_sandbox_onboarding
  ON commerce_merchants(tenant_id, sandbox_onboarding_state);
