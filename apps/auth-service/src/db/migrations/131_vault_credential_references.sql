-- SPDX-License-Identifier: Apache-2.0
-- Credential references: a short-lived handle the vault exchange hands an agent
-- instead of the raw upstream credential (VAULT_CREDENTIAL_REFERENCES_ENABLED).
-- A relying party that holds the developer's API key (the gateway) redeems the
-- handle with POST /v1/vault/credentials/resolve and injects the credential
-- upstream itself, so the agent never holds the secret.
--
-- A reference is bound to the grant that obtained it and to the vault row; it
-- expires on its own and is refused once the grant is no longer active.
-- Additive: one new table, created empty.

CREATE TABLE IF NOT EXISTS vault_credential_references (
  id                  TEXT PRIMARY KEY,
  developer_id        TEXT NOT NULL,
  vault_credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
  grant_id            TEXT NOT NULL,
  principal_id        TEXT NOT NULL,
  agent_did           TEXT NOT NULL,
  service             TEXT NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  resolved_count      INTEGER NOT NULL DEFAULT 0,
  last_resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vault_credential_references_developer_expiry
  ON vault_credential_references (developer_id, expires_at);
