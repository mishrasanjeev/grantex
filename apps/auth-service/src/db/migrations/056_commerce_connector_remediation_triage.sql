-- Grantex Commerce V1 - C6Sia: sandbox connector remediation operator triage.
-- These fields are redacted, tenant-scoped review evidence only. They do not
-- approve production launch, connector execution, public discovery,
-- checkout/payment creation, live providers, production allowlists, or
-- certification.

ALTER TABLE commerce_connector_dry_run_remediations
  ADD COLUMN IF NOT EXISTS triage_status TEXT NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS assigned_operator_id TEXT,
  ADD COLUMN IF NOT EXISTS triage_note TEXT,
  ADD COLUMN IF NOT EXISTS merchant_followup_summary TEXT,
  ADD COLUMN IF NOT EXISTS triage_next_step TEXT,
  ADD COLUMN IF NOT EXISTS triaged_by_operator_id TEXT,
  ADD COLUMN IF NOT EXISTS triaged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_audit_event_id TEXT REFERENCES commerce_audit_events(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_commerce_connector_remediations_triage_status'
  ) THEN
    ALTER TABLE commerce_connector_dry_run_remediations
      ADD CONSTRAINT chk_commerce_connector_remediations_triage_status CHECK (
        triage_status IN (
          'unassigned',
          'triage_in_progress',
          'waiting_on_merchant',
          'ready_for_followup_review',
          'blocked_for_sandbox_followup',
          'closed_no_action'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_commerce_connector_remediations_triage_lengths'
  ) THEN
    ALTER TABLE commerce_connector_dry_run_remediations
      ADD CONSTRAINT chk_commerce_connector_remediations_triage_lengths CHECK (
        (assigned_operator_id IS NULL OR char_length(assigned_operator_id) <= 128)
        AND (triage_note IS NULL OR char_length(triage_note) <= 2000)
        AND (merchant_followup_summary IS NULL OR char_length(merchant_followup_summary) <= 2000)
        AND (triage_next_step IS NULL OR char_length(triage_next_step) <= 2000)
        AND (triaged_by_operator_id IS NULL OR char_length(triaged_by_operator_id) <= 128)
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_commerce_connector_remediations_triage
  ON commerce_connector_dry_run_remediations(tenant_id, merchant_id, triage_status, updated_at DESC);
