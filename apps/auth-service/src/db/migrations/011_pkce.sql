-- PKCE support: store code challenge on auth requests
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS code_challenge TEXT;
ALTER TABLE auth_requests ADD COLUMN IF NOT EXISTS code_challenge_method TEXT;
