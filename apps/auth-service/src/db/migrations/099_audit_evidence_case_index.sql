-- Evidence packages (PRD G-5): find a case's evidence records and decision
-- grant entries without scanning the developer's whole audit chain. Partial
-- expression indexes; additive, built concurrently.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_evidence_case
  ON audit_entries (developer_id, (metadata->>'case_id'), timestamp, id)
  WHERE action LIKE 'evidence.%';
