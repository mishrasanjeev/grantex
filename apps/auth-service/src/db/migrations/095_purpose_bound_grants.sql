-- Purpose-bound grants. The purpose a Principal approves on an authorization
-- request is copied to the grant (and carried in its tokens through
-- authorization_details) and recorded on every audit entry for that grant.
-- Additive and nullable: existing requests, grants and entries have no purpose.

ALTER TABLE auth_requests
  ADD COLUMN IF NOT EXISTS purpose TEXT;

ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS purpose TEXT;

ALTER TABLE audit_entries
  ADD COLUMN IF NOT EXISTS purpose TEXT;
