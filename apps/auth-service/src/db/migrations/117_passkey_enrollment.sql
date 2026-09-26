-- Enrollment tickets are WebAuthn challenges with ceremony_type='enrollment_ticket'.
-- This binds each browser registration challenge to its issuing ticket.
ALTER TABLE webauthn_challenges
  ADD COLUMN IF NOT EXISTS enrollment_ticket_id TEXT;

CREATE INDEX IF NOT EXISTS idx_webauthn_enrollment_ticket
  ON webauthn_challenges (enrollment_ticket_id)
  WHERE enrollment_ticket_id IS NOT NULL;
