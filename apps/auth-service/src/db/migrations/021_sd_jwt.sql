ALTER TABLE verifiable_credentials ADD COLUMN IF NOT EXISTS sd_jwt_disclosures JSONB;
ALTER TABLE verifiable_credentials ADD COLUMN IF NOT EXISTS credential_format TEXT NOT NULL DEFAULT 'vc-jwt';
