-- Webhook endpoint registrations
CREATE TABLE IF NOT EXISTS webhooks (
  id           TEXT PRIMARY KEY,
  developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  events       TEXT[] NOT NULL,
  secret       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
