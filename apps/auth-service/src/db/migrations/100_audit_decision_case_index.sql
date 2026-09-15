CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_decision_case
  ON audit_entries (developer_id, ((metadata->'action')->>'case_id'), timestamp, id)
  WHERE action IN ('decision.approved', 'decision.consumed');
