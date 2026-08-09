CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_policies_evaluation
  ON policies (developer_id, priority DESC, created_at ASC);
