-- Sandbox mode: developers can be 'live' (default) or 'sandbox'
ALTER TABLE developers ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'live';
