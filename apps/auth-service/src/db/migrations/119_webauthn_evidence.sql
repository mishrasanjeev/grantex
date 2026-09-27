-- Preserve the verified assertion across consent, grant issuance and refresh.
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS fido_evidence JSONB;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS fido_evidence JSONB;
