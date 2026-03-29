-- Add LDAP as a third SSO protocol alongside OIDC and SAML 2.0.

-- Drop and re-add the protocol check constraint to include 'ldap'
ALTER TABLE sso_connections DROP CONSTRAINT IF EXISTS sso_connections_protocol_check;
ALTER TABLE sso_connections ADD CONSTRAINT sso_connections_protocol_check
  CHECK (protocol IN ('oidc', 'saml', 'ldap'));

-- LDAP-specific columns
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_url          TEXT;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_bind_dn      TEXT;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_bind_password TEXT;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_search_base   TEXT;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_search_filter TEXT DEFAULT '(uid={{username}})';
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_group_search_base   TEXT;
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_group_search_filter TEXT DEFAULT '(member={{dn}})';
ALTER TABLE sso_connections ADD COLUMN IF NOT EXISTS ldap_tls_enabled   BOOLEAN NOT NULL DEFAULT false;
