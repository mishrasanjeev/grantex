-- SPDX-License-Identifier: Apache-2.0
-- Commerce ledger (G16).
--
-- 1. commerce_arbiter_decisions: every decision AgenticOrg's policy arbiter
--    seals, append-only, keyed by its decision_id. An allow carries the
--    claims of the machine-profile decision grant countersigning it
--    (spec/decision-grant.md section 10); a refusal carries none.
-- 2. audit_witness_checkpoints / audit_witness_forks: AgenticOrg audit chain
--    heads countersigned by the platform key, and refused forks.
-- 3. wallet_ledger_entries tamper evidence: chain_seq, prev_hash and
--    entry_hash, chained per wallet by a BEFORE INSERT trigger, with existing
--    rows backfilled in (created_at, id) order (section 3 below).
--
-- Every statement is idempotent: the migration ledger may run a file again
-- on a database that predates the ledger.

CREATE TABLE IF NOT EXISTS commerce_arbiter_decisions (
  decision_id      TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  merchant_id      TEXT NOT NULL,
  seller_agent_id  TEXT NOT NULL,
  buyer_agent_id   TEXT NOT NULL,
  action           TEXT NOT NULL,
  action_hash      TEXT NOT NULL,
  outcome          TEXT NOT NULL,
  rules_evaluated  JSONB NOT NULL,
  failing_rule     TEXT,
  evidence         JSONB NOT NULL,
  decided_at       TIMESTAMPTZ NOT NULL,
  policy_version   TEXT NOT NULL,
  -- Lowercase hex SHA-256 of the RFC 8785 form of the posted decision: the
  -- same decision_id with another body is refused (409).
  request_hash     TEXT NOT NULL,
  grant_jti        TEXT UNIQUE,
  grant_claims     JSONB,
  grant_expires_at TIMESTAMPTZ,
  service_id       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_arbiter_outcome CHECK (outcome IN ('allow', 'refuse')),
  CONSTRAINT chk_arbiter_action_hash CHECK (action_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_arbiter_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- A refusal names its failing rule; an allow names none.
  CONSTRAINT chk_arbiter_failing_rule CHECK ((outcome = 'refuse') = (failing_rule IS NOT NULL)),
  -- A grant exists for an allow and never for a refusal: a token is a permission.
  CONSTRAINT chk_arbiter_grant CHECK (
    (outcome = 'allow') = (grant_jti IS NOT NULL)
    AND (grant_jti IS NULL) = (grant_claims IS NULL)
    AND (grant_jti IS NULL) = (grant_expires_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_commerce_arbiter_decisions_tenant
  ON commerce_arbiter_decisions(tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_commerce_arbiter_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commerce_arbiter_decisions is append-only';
END
$$;

DROP TRIGGER IF EXISTS trg_commerce_arbiter_decisions_no_update_delete ON commerce_arbiter_decisions;
CREATE TRIGGER trg_commerce_arbiter_decisions_no_update_delete
  BEFORE UPDATE OR DELETE ON commerce_arbiter_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_commerce_arbiter_decision_mutation();

DROP TRIGGER IF EXISTS trg_commerce_arbiter_decisions_no_truncate ON commerce_arbiter_decisions;
CREATE TRIGGER trg_commerce_arbiter_decisions_no_truncate
  BEFORE TRUNCATE ON commerce_arbiter_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_commerce_arbiter_decision_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON commerce_arbiter_decisions TO grantex_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON commerce_arbiter_decisions FROM grantex_app';
  END IF;
END
$$;

-- 2. audit_witness_checkpoints: chain heads AgenticOrg anchors, countersigned
--    with the platform key. One head per (source, tenant_ref, chain,
--    head_seq): a second, different head_hash for a witnessed position is a
--    fork, refused and recorded in audit_witness_forks. The countersignature
--    is evidence, not a credential, so it is stored and replayed as issued.

CREATE TABLE IF NOT EXISTS audit_witness_checkpoints (
  witness_id       TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  tenant_ref       TEXT NOT NULL,
  chain            TEXT NOT NULL,
  head_seq         BIGINT NOT NULL,
  head_hash        TEXT NOT NULL,
  anchored_at      TIMESTAMPTZ NOT NULL,
  witnessed_at     TIMESTAMPTZ NOT NULL,
  countersignature TEXT NOT NULL,
  service_id       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_audit_witness_head_seq CHECK (head_seq >= 0),
  CONSTRAINT chk_audit_witness_head_hash CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT uq_audit_witness_position UNIQUE (source, tenant_ref, chain, head_seq)
);

CREATE TABLE IF NOT EXISTS audit_witness_forks (
  id                    TEXT PRIMARY KEY,
  witness_id            TEXT NOT NULL REFERENCES audit_witness_checkpoints(witness_id),
  source                TEXT NOT NULL,
  tenant_ref            TEXT NOT NULL,
  chain                 TEXT NOT NULL,
  head_seq              BIGINT NOT NULL,
  witnessed_hash        TEXT NOT NULL,
  presented_hash        TEXT NOT NULL,
  presented_anchored_at TIMESTAMPTZ NOT NULL,
  service_id            TEXT NOT NULL,
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_witness_forks_tenant
  ON audit_witness_forks(source, tenant_ref, detected_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_witness_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_witness_checkpoints_no_update_delete ON audit_witness_checkpoints;
CREATE TRIGGER trg_audit_witness_checkpoints_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_witness_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_audit_witness_mutation();

DROP TRIGGER IF EXISTS trg_audit_witness_checkpoints_no_truncate ON audit_witness_checkpoints;
CREATE TRIGGER trg_audit_witness_checkpoints_no_truncate
  BEFORE TRUNCATE ON audit_witness_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_witness_mutation();

DROP TRIGGER IF EXISTS trg_audit_witness_forks_no_update_delete ON audit_witness_forks;
CREATE TRIGGER trg_audit_witness_forks_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_witness_forks
  FOR EACH ROW EXECUTE FUNCTION reject_audit_witness_mutation();

DROP TRIGGER IF EXISTS trg_audit_witness_forks_no_truncate ON audit_witness_forks;
CREATE TRIGGER trg_audit_witness_forks_no_truncate
  BEFORE TRUNCATE ON audit_witness_forks
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_witness_mutation();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantex_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON audit_witness_checkpoints, audit_witness_forks TO grantex_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_witness_checkpoints, audit_witness_forks FROM grantex_app';
  END IF;
END
$$;

-- 3. wallet_ledger_entries tamper evidence.
--
-- Every entry carries its position in its wallet's chain (chain_seq, from 1),
-- the entry_hash of the entry before it (prev_hash, NULL for the first) and
-- its own entry_hash:
--
--   entry_hash = lowercase hex SHA-256 of the UTF-8 bytes of
--     "grantex.wallet_ledger_entry.v1" LF
--     F(chain_seq) F(prev_hash) F(id) F(wallet_id) F(developer_id)
--     F(principal_id) F(entry_type) F(amount) F(available_after)
--     F(reserved_after) F(reservation_id) F(reload_request_id)
--     F(external_reference) F(metadata::text)
--     F(created_at as YYYY-MM-DDTHH:MI:SS.ffffffZ in UTC)
--
--   F(NULL) = "~" LF;  F(v) = <octet length of v in UTF-8> ":" v LF
--
-- Numbers are their canonical PostgreSQL text form; metadata is the jsonb
-- text form, which PostgreSQL normalises on input. The length prefix keeps
-- every field boundary unambiguous. lib/wallet-ledger-chain.ts computes the
-- same hash from the same text forms, so a chain can be verified outside the
-- database from an export of those columns.
--
-- The hash is computed in the database, by a BEFORE INSERT trigger, rather
-- than at each insert site: every path that writes the ledger (the four in
-- lib/prepaid-wallet.ts, base-usdc reconciliation, and any added later) is
-- chained without being able to forget it, and a caller-supplied chain_seq,
-- prev_hash or entry_hash is always overwritten. The trigger takes a
-- transaction-scoped advisory lock per wallet before reading the head, so
-- two inserts for one wallet can never take the same position; every insert
-- site already holds the wallet row lock (UPDATE prepaid_wallets) by then,
-- so the advisory lock is uncontended and adds no lock-order hazard. The
-- unique index on (wallet_id, chain_seq) is the backstop: a writer that ever
-- read a stale head fails rather than forks the chain.
--
-- Backfill: the table is append-only (091: a trigger refuses UPDATE and
-- DELETE). The backfill disables that trigger for the duration of this
-- migration's transaction and enables it again before commit. The
-- ADD COLUMN statements below already hold an ACCESS EXCLUSIVE lock on the
-- table, so no other session can write, or observe the trigger disabled,
-- before the commit; and because DDL is transactional, a failed backfill
-- rolls back with the trigger still enabled. The alternative, a permanent
-- exception in reject_wallet_ledger_mutation() allowing NULL hash columns to
-- be filled, would leave a standing UPDATE path on an append-only table for
-- a one-off backfill. Existing rows are chained per wallet in
-- (created_at, id) order, deterministically; only rows whose entry_hash is
-- NULL are touched, so a re-run changes nothing.

ALTER TABLE wallet_ledger_entries ADD COLUMN IF NOT EXISTS chain_seq BIGINT;
ALTER TABLE wallet_ledger_entries ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE wallet_ledger_entries ADD COLUMN IF NOT EXISTS entry_hash TEXT;

CREATE OR REPLACE FUNCTION wallet_ledger_hash_field(value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN value IS NULL THEN '~'
              ELSE octet_length(convert_to(value, 'UTF8'))::text || ':' || value END || E'\n'
$$;

CREATE OR REPLACE FUNCTION wallet_ledger_entry_hash(
  p_chain_seq BIGINT, p_prev_hash TEXT, p_id TEXT, p_wallet_id TEXT, p_developer_id TEXT,
  p_principal_id TEXT, p_entry_type TEXT, p_amount NUMERIC, p_available_after NUMERIC,
  p_reserved_after NUMERIC, p_reservation_id TEXT, p_reload_request_id TEXT,
  p_external_reference TEXT, p_metadata JSONB, p_created_at TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(
    'grantex.wallet_ledger_entry.v1' || E'\n'
    || wallet_ledger_hash_field(p_chain_seq::text)
    || wallet_ledger_hash_field(p_prev_hash)
    || wallet_ledger_hash_field(p_id)
    || wallet_ledger_hash_field(p_wallet_id)
    || wallet_ledger_hash_field(p_developer_id)
    || wallet_ledger_hash_field(p_principal_id)
    || wallet_ledger_hash_field(p_entry_type)
    || wallet_ledger_hash_field(p_amount::text)
    || wallet_ledger_hash_field(p_available_after::text)
    || wallet_ledger_hash_field(p_reserved_after::text)
    || wallet_ledger_hash_field(p_reservation_id)
    || wallet_ledger_hash_field(p_reload_request_id)
    || wallet_ledger_hash_field(p_external_reference)
    || wallet_ledger_hash_field(p_metadata::text)
    || wallet_ledger_hash_field(to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
    'UTF8')), 'hex')
$$;

ALTER TABLE wallet_ledger_entries DISABLE TRIGGER trg_wallet_ledger_no_update_delete;

DO $$
DECLARE
  w RECORD;
  r RECORD;
  v_seq BIGINT;
  v_prev TEXT;
  v_hash TEXT;
BEGIN
  FOR w IN SELECT DISTINCT wallet_id FROM wallet_ledger_entries WHERE entry_hash IS NULL ORDER BY wallet_id LOOP
    v_seq := NULL;
    v_prev := NULL;
    SELECT chain_seq, entry_hash INTO v_seq, v_prev
      FROM wallet_ledger_entries
     WHERE wallet_id = w.wallet_id AND entry_hash IS NOT NULL
     ORDER BY chain_seq DESC
     LIMIT 1;
    v_seq := COALESCE(v_seq, 0);
    FOR r IN
      SELECT * FROM wallet_ledger_entries
       WHERE wallet_id = w.wallet_id AND entry_hash IS NULL
       ORDER BY created_at, id
    LOOP
      v_seq := v_seq + 1;
      v_hash := wallet_ledger_entry_hash(
        v_seq, v_prev, r.id, r.wallet_id, r.developer_id, r.principal_id, r.entry_type,
        r.amount, r.available_after, r.reserved_after, r.reservation_id, r.reload_request_id,
        r.external_reference, r.metadata, r.created_at);
      UPDATE wallet_ledger_entries
         SET chain_seq = v_seq, prev_hash = v_prev, entry_hash = v_hash
       WHERE id = r.id;
      v_prev := v_hash;
    END LOOP;
  END LOOP;
END
$$;

ALTER TABLE wallet_ledger_entries ENABLE TRIGGER trg_wallet_ledger_no_update_delete;

ALTER TABLE wallet_ledger_entries ALTER COLUMN chain_seq SET NOT NULL;
ALTER TABLE wallet_ledger_entries ALTER COLUMN entry_hash SET NOT NULL;

ALTER TABLE wallet_ledger_entries DROP CONSTRAINT IF EXISTS chk_wallet_ledger_chain;
ALTER TABLE wallet_ledger_entries ADD CONSTRAINT chk_wallet_ledger_chain CHECK (
  chain_seq >= 1
  AND entry_hash ~ '^[0-9a-f]{64}$'
  AND (chain_seq = 1) = (prev_hash IS NULL)
  AND (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_ledger_chain
  ON wallet_ledger_entries(wallet_id, chain_seq);

CREATE OR REPLACE FUNCTION wallet_ledger_chain_entry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_seq BIGINT;
  v_prev TEXT;
BEGIN
  -- One writer per wallet chain at a time, until this transaction ends.
  PERFORM pg_advisory_xact_lock(hashtextextended('grantex:wallet_ledger_chain:' || NEW.wallet_id, 0));
  SELECT chain_seq, entry_hash INTO v_seq, v_prev
    FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id AND chain_seq IS NOT NULL
   ORDER BY chain_seq DESC
   LIMIT 1;
  NEW.chain_seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := v_prev;
  NEW.entry_hash := wallet_ledger_entry_hash(
    NEW.chain_seq, NEW.prev_hash, NEW.id, NEW.wallet_id, NEW.developer_id, NEW.principal_id,
    NEW.entry_type, NEW.amount, NEW.available_after, NEW.reserved_after, NEW.reservation_id,
    NEW.reload_request_id, NEW.external_reference, NEW.metadata, NEW.created_at);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_wallet_ledger_chain ON wallet_ledger_entries;
CREATE TRIGGER trg_wallet_ledger_chain
  BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_chain_entry();
