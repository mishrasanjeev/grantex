-- SPDX-License-Identifier: Apache-2.0
-- Per-merchant child grants (Agent Trust Registry, Phase 1; PRD §8.5,
-- Appendix B; owner decision 3; spec/passport-binding.md §8).
--
-- With PASSPORT_BOUND_GRANTS_ENABLED=true, the authorization request of a
-- passport-bound grant may name the merchants it is for in a
-- urn:grantex:commerce:v1 authorization_details entry (RFC 9396 §2):
-- allowed_merchants, exact origins, and optional amount_range and budget.
-- grant_passport_bindings.commerce_constraints keeps them, as the rest of the
-- commerce entry is kept there and rebuilt at every issuance and refresh.
--
-- POST /v1/token with the RFC 8693 token-exchange grant type then turns the
-- parent's grant token into a child token for one merchant. A child is a
-- token of the parent grant: its grant_tokens row names the parent grant, so
-- revoking the grant revokes every child with it (the existing checks join
-- grant_tokens to grants), and a budget debit made with the child's grant id
-- lands on the parent's allocation. grant_child_tokens records what the
-- child was issued for and which token it was exchanged from (parent_jti),
-- so revoking that token revokes its children too.
--
-- Additive. One nullable column on grant_passport_bindings (no rewrite, no
-- default) and one new, empty table. Nothing writes either until the flag
-- is turned on; the token revocation reads grant_child_tokens and finds
-- nothing.

ALTER TABLE grant_passport_bindings
  ADD COLUMN IF NOT EXISTS commerce_constraints JSONB
  CONSTRAINT chk_grant_passport_bindings_commerce_constraints
    CHECK (commerce_constraints IS NULL OR jsonb_typeof(commerce_constraints) = 'object');

CREATE TABLE IF NOT EXISTS grant_child_tokens (
  -- The child's jti. Removed with its grant_tokens row (an agent's deletion
  -- removes its grants' tokens).
  jti              TEXT PRIMARY KEY REFERENCES grant_tokens(jti) ON DELETE CASCADE,
  -- The parent grant: the child is one of its tokens.
  grant_id         TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  developer_id     TEXT NOT NULL,
  -- The jti of the subject token the child was exchanged from. Not a
  -- foreign key: a parent token row may be pruned before its children expire,
  -- and the revocation that reads this column must never be refused for it.
  parent_jti       TEXT NOT NULL,
  -- The child's aud: one of the parent's allowed_merchants, an exact origin.
  merchant_origin  TEXT NOT NULL,
  -- The child's commerce constraints, never wider than the parent's.
  constraints      JSONB NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_grant_child_tokens_constraints CHECK (jsonb_typeof(constraints) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_grant_child_tokens_parent_jti
  ON grant_child_tokens (parent_jti);
CREATE INDEX IF NOT EXISTS idx_grant_child_tokens_grant
  ON grant_child_tokens (grant_id);
