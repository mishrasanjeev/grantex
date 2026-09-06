-- Signed EVM authorizations remain an exposure until finalized chain reconciliation.
ALTER TABLE wallet_payment_reservations
  ADD COLUMN IF NOT EXISTS evm_payment_ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS evm_from_block TEXT,
  ADD COLUMN IF NOT EXISTS evm_transaction_hash TEXT;

-- One on-chain balance must never back multiple independently spendable ledgers.
CREATE UNIQUE INDEX IF NOT EXISTS uq_base_usdc_custody_address
  ON prepaid_wallets (lower(wallet_address))
  WHERE custody_mode = 'external' AND provider = 'base_usdc';
