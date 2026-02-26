-- Gap 1: audience on auth requests
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS audience TEXT;

-- Gap 2: status on audit entries
ALTER TABLE audit_entries ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success';

-- Gap 3: delegation chain on grants
ALTER TABLE grants ADD COLUMN IF NOT EXISTS parent_grant_id TEXT REFERENCES grants(id);
ALTER TABLE grants ADD COLUMN IF NOT EXISTS delegation_depth INTEGER NOT NULL DEFAULT 0;
