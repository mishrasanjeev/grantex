-- SPDX-License-Identifier: Apache-2.0
-- Agent lifecycle states.
--
--   draft      registered, not yet usable: no grant is issued to it
--   active     usable (the default, as before)
--   suspended  paused by its developer; resumable
--   retired    final: no grant is issued to it again, and it cannot be reactivated
--
-- Issuance already requires status = 'active', so the two new states need no
-- further enforcement there. The transition rules live in routes/agents.ts.
-- Additive: three nullable columns and a check constraint over the values the
-- API has ever written.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS status_reason TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS ck_agents_status;
ALTER TABLE agents ADD CONSTRAINT ck_agents_status
  CHECK (status IN ('draft', 'active', 'suspended', 'retired')) NOT VALID;
ALTER TABLE agents VALIDATE CONSTRAINT ck_agents_status;
