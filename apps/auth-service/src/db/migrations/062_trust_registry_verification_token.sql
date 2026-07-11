-- Persist only a one-way hash of Trust Registry DNS verification tokens.
-- Existing rows remain NULL and use the exact legacy did:web DNS proof.
ALTER TABLE trust_registry
  ADD COLUMN IF NOT EXISTS verification_token_hash TEXT,
  ALTER COLUMN verified_at DROP NOT NULL,
  ALTER COLUMN verified_at DROP DEFAULT,
  ALTER COLUMN verification_method SET DEFAULT 'pending';

COMMENT ON COLUMN trust_registry.verification_token_hash IS
  'SHA-256 hash of the one-time DNS TXT verification token; cleared after successful verification';

-- Earlier releases inserted third-party demo rows at process startup and marked
-- them verified, manual, or SOC 2 without retaining verification evidence.
-- Remove untouched rows and neutralize any that acquired dependent agent rows.
DELETE FROM trust_registry AS registry
WHERE registry.developer_id IS NULL
  AND registry.organization_did IN (
    'did:web:pinelabs.com',
    'did:web:acme-demo.dev',
    'did:web:shopify.com',
    'did:web:doordash.com',
    'did:web:grantex.dev'
  )
  AND NOT EXISTS (
    SELECT 1 FROM registry_agents AS agent
    WHERE agent.registry_id = registry.id
  );

UPDATE trust_registry
SET trust_level = 'basic',
    verification_method = 'pending',
    verified_at = NULL,
    verification_token_hash = NULL,
    badges = '{}',
    compliance_soc2 = false,
    compliance_iso27001 = false,
    compliance_dpdp = false,
    compliance_gdpr = false,
    updated_at = NOW()
WHERE developer_id IS NULL
  AND organization_did IN (
    'did:web:pinelabs.com',
    'did:web:acme-demo.dev',
    'did:web:shopify.com',
    'did:web:doordash.com',
    'did:web:grantex.dev'
  );
