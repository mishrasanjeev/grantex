-- SPDX-License-Identifier: Apache-2.0
-- Agent key history (PRD §5 Agent, §7 Keys, §8.8; owner decision 12).
--
-- An agent used to hold one key: agents.public_jwk and agents.key_thumbprint,
-- unique across every agent through idx_agents_key_thumbprint_unique (090).
-- agent_keys keeps every key an agent has held, with its lifecycle:
--
--   pending      registered, possession not yet proven
--   active       possession proven (a signed challenge, or a DPoP proof at
--                the token endpoint for a key that predates the challenge)
--   rotated      replaced; usable until valid_to, the end of the overlap
--   compromised  never usable again; valid_to is the moment it was reported
--
-- A thumbprint (RFC 7638, SHA-256) is unique across the whole table, so one
-- key can never belong to two agents. A key that was reported compromised is
-- also recorded in compromised_agent_keys, which has no foreign key: it
-- outlives the agent, so the key can never be registered again by anyone,
-- even after the agent that held it is deleted.
--
-- Additive. agents.public_jwk and agents.key_thumbprint stay what every
-- existing path reads, and idx_agents_key_thumbprint_unique stays in place
-- until those paths read agent_keys instead. A trigger mirrors the agents
-- columns into agent_keys, so the history is complete whichever route wrote
-- the key, and refuses (with the same constraint name the existing routes
-- already map to 409) a key another agent holds in its history. Nothing a
-- request could do before this migration behaves differently after it: the
-- only new refusals are for states that only the new key routes can create.
--
-- Backfill (owner decision 12): every existing agents.public_jwk becomes an
-- agent_keys row. It is active, with possession_proved_at set, when its
-- thumbprint equals the DPoP-proven key_verified_thumbprint; otherwise it is
-- pending until the agent proves possession.

-- The rails an agent declares. An agent that declares a payments rail (AP2,
-- Verifiable Intent) must sign with ES256 on P-256 (PRD §6). Constant
-- default: no table rewrite; the check scans agents once.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS declared_rails TEXT[] NOT NULL DEFAULT '{}'
  CONSTRAINT chk_agents_declared_rails
    CHECK (declared_rails <@ ARRAY['ap2', 'verifiable_intent', 'acp', 'ucp']::TEXT[]);

CREATE TABLE IF NOT EXISTS agent_keys (
  thumbprint            TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  developer_id          TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  jwk                   JSONB NOT NULL,
  alg                   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  valid_from            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to              TIMESTAMPTZ,
  possession_proved_at  TIMESTAMPTZ,
  -- On a replacement key: the key it replaced.
  rotated_from          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_agent_keys_status CHECK (status IN ('pending', 'active', 'rotated', 'compromised')),
  CONSTRAINT chk_agent_keys_alg CHECK (alg IN ('ES256', 'ES384', 'ES512', 'EdDSA', 'RS256')),
  -- An active key has been proven, and a key that has ended says when.
  CONSTRAINT chk_agent_keys_active_proved CHECK (status <> 'active' OR possession_proved_at IS NOT NULL),
  CONSTRAINT chk_agent_keys_ended CHECK (status NOT IN ('rotated', 'compromised') OR valid_to IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_agent_keys_agent
  ON agent_keys (agent_id, created_at DESC);

-- Every thumbprint ever reported compromised. Deliberately without a foreign
-- key to agents or developers: deleting either must not make a leaked key
-- registrable again. Rows are only ever added.
CREATE TABLE IF NOT EXISTS compromised_agent_keys (
  thumbprint   TEXT PRIMARY KEY,
  reported_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server-issued possession challenges. Only a SHA-256 hash of the nonce is
-- stored. consumed_at is set by the one proof that uses it, atomically, so a
-- nonce proves possession at most once; consumed rows stay so a replay is
-- recognised as one.
CREATE TABLE IF NOT EXISTS agent_key_challenges (
  nonce_hash   TEXT PRIMARY KEY,
  thumbprint   TEXT NOT NULL REFERENCES agent_keys(thumbprint) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_key_challenges_key
  ON agent_key_challenges (thumbprint, created_at);

-- The JWS algorithm of a public JWK the agents routes accepted
-- (lib/agent-security.ts): RFC 7518 §3.1 names, RFC 8037 §3.1 for Ed25519.
CREATE OR REPLACE FUNCTION grantex_agent_key_alg(jwk JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jwk->>'kty'
    WHEN 'OKP' THEN CASE WHEN jwk->>'crv' = 'Ed25519' THEN 'EdDSA' END
    WHEN 'RSA' THEN 'RS256'
    WHEN 'EC' THEN CASE jwk->>'crv'
      WHEN 'P-256' THEN 'ES256'
      WHEN 'P-384' THEN 'ES384'
      WHEN 'P-521' THEN 'ES512'
    END
  END
$$;

-- The P-256 rule, where no route can miss it: a key that enters an agent's
-- history must be ES256 when the agent declares a payments rail. The agent
-- row is read FOR SHARE, so a concurrent change of declared_rails (which
-- takes the row FOR UPDATE and checks the keys) cannot interleave.
--
-- It runs whenever a key can become usable (inserted, or moved back to
-- pending or active, as PATCH /v1/agents does for a key the agent held
-- before), and not when a key ends: rotating or compromising a key of another
-- type must stay possible under a payments rail.
CREATE OR REPLACE FUNCTION grantex_agent_key_rail_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rails TEXT[];
BEGIN
  IF NEW.status NOT IN ('pending', 'active') THEN
    RETURN NEW;
  END IF;
  SELECT declared_rails INTO rails FROM agents WHERE id = NEW.agent_id FOR SHARE;
  IF rails && ARRAY['ap2', 'verifiable_intent']::TEXT[] AND NEW.alg <> 'ES256' THEN
    RAISE EXCEPTION 'an agent that declares a payments rail must use ES256 keys on P-256'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_agent_keys_payments_rail_alg';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER agent_keys_rail_check_trg
  BEFORE INSERT OR UPDATE OF agent_id, alg, status ON agent_keys
  FOR EACH ROW EXECUTE FUNCTION grantex_agent_key_rail_check();

-- The compromise tombstone, where no route can miss it: a key marked
-- compromised is recorded in compromised_agent_keys, and a recorded key can
-- never again be written to agent_keys in any other state. The mirror below
-- inserts into agent_keys for POST and PATCH /v1/agents, so those routes are
-- covered as well as POST /v1/agents/:id/keys.
CREATE OR REPLACE FUNCTION grantex_agent_key_compromise_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'compromised' THEN
    INSERT INTO compromised_agent_keys (thumbprint) VALUES (NEW.thumbprint)
    ON CONFLICT (thumbprint) DO NOTHING;
  ELSIF EXISTS (SELECT 1 FROM compromised_agent_keys WHERE thumbprint = NEW.thumbprint) THEN
    RAISE EXCEPTION 'agent key was reported compromised'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_agent_keys_not_compromised';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER agent_keys_compromise_check_trg
  BEFORE INSERT OR UPDATE ON agent_keys
  FOR EACH ROW EXECUTE FUNCTION grantex_agent_key_compromise_check();

-- Keep agent_keys complete when POST or PATCH /v1/agents writes the key
-- columns, and record a DPoP proof of the registered key as a possession
-- proof (owner decision 12).
CREATE OR REPLACE FUNCTION grantex_agent_key_mirror() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  existing agent_keys%ROWTYPE;
  key_alg TEXT;
BEGIN
  IF NEW.key_thumbprint IS NOT NULL AND NEW.public_jwk IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.key_thumbprint IS DISTINCT FROM OLD.key_thumbprint) THEN
    key_alg := grantex_agent_key_alg(NEW.public_jwk);
    IF key_alg IS NULL THEN
      -- The routes only store keys this function understands. Anything else
      -- cannot be tracked, so it is refused rather than left out of the history.
      RAISE EXCEPTION 'agent key has no supported algorithm'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_agent_keys_alg';
    END IF;
    SELECT * INTO existing FROM agent_keys WHERE thumbprint = NEW.key_thumbprint FOR UPDATE;
    IF FOUND THEN
      IF existing.status = 'compromised' THEN
        RAISE EXCEPTION 'agent key was reported compromised'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_agent_keys_not_compromised';
      ELSIF existing.agent_id = NEW.id THEN
        -- Back to a key this agent held before: registered again, so it has
        -- to be proven again, as PATCH /v1/agents already requires.
        IF existing.status = 'rotated' THEN
          UPDATE agent_keys
             SET status = 'pending', valid_from = NOW(), valid_to = NULL,
                 possession_proved_at = NULL, updated_at = NOW()
           WHERE thumbprint = NEW.key_thumbprint;
        END IF;
      ELSIF existing.status IN ('pending', 'active')
            OR (existing.valid_to IS NOT NULL AND existing.valid_to > NOW()) THEN
        -- Another agent holds this key. The constraint name is the one the
        -- agents routes already answer with 409 AGENT_KEY_CONFLICT.
        RAISE EXCEPTION 'agent key is registered to another agent'
          USING ERRCODE = 'unique_violation', CONSTRAINT = 'idx_agents_key_thumbprint_unique';
      ELSE
        -- A key another agent replaced and no longer uses. The agents index
        -- has always allowed it to be registered again, so it still can be;
        -- the history row moves to the new holder, unproven.
        DELETE FROM agent_key_challenges WHERE thumbprint = NEW.key_thumbprint;
        UPDATE agent_keys
           SET agent_id = NEW.id, developer_id = NEW.developer_id, jwk = NEW.public_jwk,
               alg = key_alg, status = 'pending', valid_from = NOW(), valid_to = NULL,
               possession_proved_at = NULL, rotated_from = NULL, updated_at = NOW()
         WHERE thumbprint = NEW.key_thumbprint;
      END IF;
    ELSE
      INSERT INTO agent_keys (thumbprint, agent_id, developer_id, jwk, alg, status)
      VALUES (NEW.key_thumbprint, NEW.id, NEW.developer_id, NEW.public_jwk, key_alg, 'pending');
    END IF;
  END IF;

  -- PATCH /v1/agents replaces the key at once: the old one ends now.
  IF TG_OP = 'UPDATE' AND OLD.key_thumbprint IS NOT NULL
     AND OLD.key_thumbprint IS DISTINCT FROM NEW.key_thumbprint THEN
    UPDATE agent_keys
       SET status = 'rotated', valid_to = NOW(), updated_at = NOW()
     WHERE thumbprint = OLD.key_thumbprint AND agent_id = NEW.id
       AND status IN ('pending', 'active');
  END IF;

  IF NEW.key_verified_thumbprint IS NOT NULL
     AND NEW.key_verified_thumbprint = NEW.key_thumbprint
     AND (TG_OP = 'INSERT'
          OR NEW.key_verified_thumbprint IS DISTINCT FROM OLD.key_verified_thumbprint
          OR NEW.key_verified_at IS DISTINCT FROM OLD.key_verified_at) THEN
    UPDATE agent_keys
       SET status = 'active', possession_proved_at = COALESCE(NEW.key_verified_at, NOW()), updated_at = NOW()
     WHERE thumbprint = NEW.key_verified_thumbprint AND agent_id = NEW.id AND status = 'pending';
  END IF;
  RETURN NULL;
END
$$;

CREATE OR REPLACE TRIGGER agents_key_mirror_trg
  AFTER INSERT OR UPDATE OF key_thumbprint, public_jwk, key_verified_thumbprint, key_verified_at ON agents
  FOR EACH ROW EXECUTE FUNCTION grantex_agent_key_mirror();

-- Backfill. Idempotent: a key already in the history is left as it is.
-- A registered key whose algorithm cannot be derived (a key type the routes
-- never accepted) cannot enter the history; it is reported below instead of
-- being left out silently.
INSERT INTO agent_keys (thumbprint, agent_id, developer_id, jwk, alg, status, valid_from, possession_proved_at)
SELECT a.key_thumbprint,
       a.id,
       a.developer_id,
       a.public_jwk,
       grantex_agent_key_alg(a.public_jwk),
       CASE WHEN a.key_verified_thumbprint = a.key_thumbprint AND a.key_verified_at IS NOT NULL
            THEN 'active' ELSE 'pending' END,
       a.updated_at,
       CASE WHEN a.key_verified_thumbprint = a.key_thumbprint AND a.key_verified_at IS NOT NULL
            THEN a.key_verified_at END
  FROM agents a
 WHERE a.key_thumbprint IS NOT NULL
   AND a.public_jwk IS NOT NULL
   AND grantex_agent_key_alg(a.public_jwk) IS NOT NULL
ON CONFLICT (thumbprint) DO NOTHING;

DO $$
DECLARE
  skipped INTEGER;
  sample TEXT;
BEGIN
  SELECT COUNT(*), string_agg(id, ', ' ORDER BY id) FILTER (WHERE rn <= 20)
    INTO skipped, sample
    FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
            FROM agents
           WHERE key_thumbprint IS NOT NULL AND public_jwk IS NOT NULL
             AND grantex_agent_key_alg(public_jwk) IS NULL) unsupported;
  IF skipped > 0 THEN
    -- A warning, not a failure: each stays the agent's registered key exactly
    -- as before this migration, and failing here would stop the service from
    -- starting. The operator sees which agents need a supported key; the
    -- mirror refuses any further write of such a key.
    RAISE WARNING '% registered agent key(s) have no supported algorithm and were not added to agent_keys (agents: %)',
      skipped, sample;
  END IF;
END
$$;
