import { auditMetadataForResponse } from './hash.js';

/** Map a database audit row to the public API shape, decoding legacy metadata in memory. */
export function toAuditEntryResponse(row: Record<string, unknown>) {
  return {
    entryId: row['id'],
    agentId: row['agent_id'],
    agentDid: row['agent_did'],
    grantId: row['grant_id'],
    principalId: row['principal_id'],
    developerId: row['developer_id'],
    action: row['action'],
    metadata: auditMetadataForResponse(row['metadata']),
    hash: row['hash'],
    prevHash: row['previous_hash'] ?? null,
    timestamp: row['timestamp'],
    status: row['status'] ?? 'success',
  };
}
