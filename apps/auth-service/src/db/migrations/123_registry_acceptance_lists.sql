-- SPDX-License-Identifier: Apache-2.0
-- The registry's attestation-acceptance status lists: whether the registry,
-- under its own issuer identifier, accepts each registered attestation. They
-- are published as a Token Status List (draft-ietf-oauth-status-list) and as
-- Bitstring Status List credentials (W3C Bitstring Status List v1.0), both
-- built from these rows.
--
-- The lists are the registry's own. There is no developer or tenant column on
-- purpose: an accredited issuer's attestation is accepted or not by the
-- registry, for every relying party alike.
--
-- Additive: two new tables, created empty. Nothing writes to them until an
-- attestation is registered.

CREATE TABLE IF NOT EXISTS registry_acceptance_lists (
  id          TEXT PRIMARY KEY,
  -- Entries in the list. Bitstring Status List v1.0 §3.2 refuses fewer than
  -- 131,072; a multiple of 8 keeps both byte arrays whole.
  capacity    INTEGER NOT NULL,
  -- Entries handed out. Indices are drawn at random, so this is a count,
  -- never the next index.
  allocated   INTEGER NOT NULL DEFAULT 0,
  -- Bumped by every status change, so the published outputs and their ETags
  -- change exactly when the content does.
  version     BIGINT NOT NULL DEFAULT 1,
  -- When an entry's status last changed.
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Start of the latest cascade window: an acceptance change or a
  -- suspension. For an hour afterwards the lists are published with a 60 s
  -- ttl instead of 600 s.
  cascade_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_registry_acceptance_lists_capacity CHECK (capacity >= 131072 AND capacity % 8 = 0),
  CONSTRAINT chk_registry_acceptance_lists_allocated CHECK (allocated >= 0 AND allocated <= capacity),
  CONSTRAINT chk_registry_acceptance_lists_version CHECK (version >= 1)
);

-- The list new entries are drawn from: the newest one with room.
CREATE INDEX IF NOT EXISTS idx_registry_acceptance_lists_created
  ON registry_acceptance_lists (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS registry_acceptance_entries (
  list_id     TEXT NOT NULL REFERENCES registry_acceptance_lists(id),
  idx         INTEGER NOT NULL,
  -- draft-ietf-oauth-status-list §7.1: 0 VALID (accepted), 1 INVALID
  -- (withdrawn, final), 2 SUSPENDED.
  status      SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The primary key is what makes an index impossible to hand out twice
  -- (draft-ietf-oauth-status-list §13.3), whatever runs concurrently.
  PRIMARY KEY (list_id, idx),
  -- The upper bound is the list's capacity, checked by the trigger below.
  CONSTRAINT chk_registry_acceptance_entries_idx CHECK (idx >= 0),
  CONSTRAINT chk_registry_acceptance_entries_status CHECK (status IN (0, 1, 2))
);

-- A status list reads only the entries that are not VALID.
CREATE INDEX IF NOT EXISTS idx_registry_acceptance_entries_not_valid
  ON registry_acceptance_entries (list_id)
  WHERE status <> 0;

-- An index must sit inside its own list, which a CHECK cannot see.
CREATE OR REPLACE FUNCTION registry_acceptance_entry_in_capacity() RETURNS trigger AS $$
DECLARE
  list_capacity INTEGER;
BEGIN
  SELECT capacity INTO list_capacity FROM registry_acceptance_lists WHERE id = NEW.list_id;
  IF list_capacity IS NULL OR NEW.idx >= list_capacity THEN
    RAISE EXCEPTION 'registry acceptance index % is outside the capacity of list %', NEW.idx, NEW.list_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_registry_acceptance_entry_in_capacity ON registry_acceptance_entries;
CREATE TRIGGER trg_registry_acceptance_entry_in_capacity
  BEFORE INSERT OR UPDATE OF list_id, idx ON registry_acceptance_entries
  FOR EACH ROW EXECUTE FUNCTION registry_acceptance_entry_in_capacity();
