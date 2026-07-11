-- Keep at most one active certification application per MCP server.
--
-- Older deployments may already contain duplicate pending applications. Keep
-- the newest pending row active and mark earlier rows as superseded before
-- adding the race-safe partial unique index.
WITH ranked_pending AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY server_id
      ORDER BY created_at DESC, id DESC
    ) AS position
  FROM mcp_certifications
  WHERE status IN ('pending_conformance_test', 'pending_review')
)
UPDATE mcp_certifications AS certification
SET status = 'superseded'
FROM ranked_pending
WHERE certification.id = ranked_pending.id
  AND ranked_pending.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_certifications_one_active
  ON mcp_certifications(server_id)
  WHERE status IN ('pending_conformance_test', 'pending_review');
