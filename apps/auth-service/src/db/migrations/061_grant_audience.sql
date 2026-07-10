-- Preserve the resource-server audience across refresh-token rotation.
-- Existing grants cannot be reliably linked back to their auth request, so
-- they remain NULL and retain the legacy no-audience refresh behaviour.
ALTER TABLE grants
  ADD COLUMN IF NOT EXISTS audience TEXT;
