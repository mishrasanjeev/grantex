-- Event bridge (PRD G-6): registered event sources and the receipt log that
-- makes ingestion replay-safe. Additive only: two new tables, nothing reads
-- them unless EVENT_BRIDGE_ENABLED=true.
--
-- A source is either an SSF/CAEP transmitter that pushes Security Event Tokens
-- (RFC 8417, verified against its JWK Set) or a generic webhook sender that
-- signs `<timestamp>.<raw body>` with HMAC-SHA256. Webhook secrets are stored
-- encrypted with VAULT_ENCRYPTION_KEY, bound to the source id.

CREATE TABLE IF NOT EXISTS event_bridge_sources (
  id                          TEXT PRIMARY KEY,
  developer_id                TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  kind                        TEXT NOT NULL,
  name                        TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'active',
  issuer                      TEXT,
  audience                    TEXT,
  jwks_uri                    TEXT,
  jwks                        JSONB,
  algorithms                  TEXT[] NOT NULL DEFAULT '{RS256,ES256}',
  max_age_seconds             INTEGER NOT NULL DEFAULT 300,
  encrypted_secret            TEXT,
  encrypted_previous_secret   TEXT,
  previous_secret_expires_at  TIMESTAMPTZ,
  secret_rotated_at           TIMESTAMPTZ,
  tolerance_seconds           INTEGER NOT NULL DEFAULT 300,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_event_bridge_sources_kind CHECK (kind IN ('ssf', 'webhook')),
  CONSTRAINT chk_event_bridge_sources_status CHECK (status IN ('active', 'disabled')),
  CONSTRAINT chk_event_bridge_sources_config CHECK (
    (kind = 'ssf' AND issuer IS NOT NULL AND audience IS NOT NULL
      AND (jwks_uri IS NOT NULL OR jwks IS NOT NULL))
    OR (kind = 'webhook' AND encrypted_secret IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_event_bridge_sources_developer
  ON event_bridge_sources (developer_id, created_at DESC);

-- One row per delivered event id (SET `jti`, webhook `id`) per source. The
-- primary key is the replay store: a second delivery of the same id is never
-- acted on again. `body_sha256` distinguishes a retransmission of the same
-- bytes from a different payload reusing an id.
CREATE TABLE IF NOT EXISTS event_bridge_receipts (
  source_id     TEXT NOT NULL REFERENCES event_bridge_sources(id) ON DELETE CASCADE,
  event_id      TEXT NOT NULL,
  developer_id  TEXT NOT NULL,
  body_sha256   TEXT NOT NULL,
  event_types   TEXT[] NOT NULL,
  status        TEXT NOT NULL,
  result        JSONB,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  PRIMARY KEY (source_id, event_id),
  CONSTRAINT chk_event_bridge_receipts_status
    CHECK (status IN ('processing', 'unmapped', 'applied', 'observed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_event_bridge_receipts_developer
  ON event_bridge_receipts (developer_id, received_at DESC);
