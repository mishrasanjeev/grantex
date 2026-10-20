-- SPDX-License-Identifier: Apache-2.0
-- OACP mandates and presence (Phase 4).
--
-- 1. Presence and authentication methods on the consent record and the
--    Commerce Passport (G44). `presence` says whether the buyer will be
--    present when the agent buys (`human_present`: each cart is confirmed
--    with the buyer's passkey) or delegated the purchase
--    (`human_not_present`: the agent buys within the consented caps without
--    a further human step). `amr` lists the authentication methods behind the
--    consent (RFC 8176 values where one exists, e.g. `otp`, plus `consent`).
--    Both columns are nullable: rows written before this migration carry
--    NULL, which every reader treats as `human_not_present` (the stricter
--    rule set for a relying party) with no methods.
--
-- Every statement is idempotent: the migration ledger may run a file again
-- on a database that predates the ledger.

ALTER TABLE commerce_consent_records ADD COLUMN IF NOT EXISTS presence TEXT;
ALTER TABLE commerce_consent_records ADD COLUMN IF NOT EXISTS amr TEXT[];
ALTER TABLE commerce_passports ADD COLUMN IF NOT EXISTS presence TEXT;
ALTER TABLE commerce_passports ADD COLUMN IF NOT EXISTS amr TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_consent_presence') THEN
    ALTER TABLE commerce_consent_records
      ADD CONSTRAINT chk_consent_presence
      CHECK (presence IS NULL OR presence IN ('human_present', 'human_not_present'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_passport_presence') THEN
    ALTER TABLE commerce_passports
      ADD CONSTRAINT chk_passport_presence
      CHECK (presence IS NULL OR presence IN ('human_present', 'human_not_present'));
  END IF;
END
$$;
