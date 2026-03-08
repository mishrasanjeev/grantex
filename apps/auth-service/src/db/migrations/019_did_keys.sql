CREATE TABLE IF NOT EXISTS signing_keys (
  id            TEXT PRIMARY KEY,
  kid           TEXT NOT NULL UNIQUE,
  algorithm     TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  private_key   TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  public_jwk    JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at    TIMESTAMPTZ
);
