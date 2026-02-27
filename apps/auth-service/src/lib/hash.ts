import { createHash, randomBytes } from 'node:crypto';

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashApiKey(key: string): string {
  return sha256hex(key);
}

export function generateApiKey(mode: 'live' | 'sandbox' = 'live'): string {
  const prefix = mode === 'sandbox' ? 'gx_test_' : 'gx_live_';
  return prefix + randomBytes(32).toString('base64url');
}

export interface AuditHashFields {
  id: string;
  agentId: string;
  agentDid: string;
  grantId: string;
  principalId: string;
  developerId: string;
  action: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  prevHash: string | null;
  status: string;
}

export function computeAuditHash(fields: AuditHashFields): string {
  const canonical = JSON.stringify({
    id: fields.id,
    agentId: fields.agentId,
    agentDid: fields.agentDid,
    grantId: fields.grantId,
    principalId: fields.principalId,
    developerId: fields.developerId,
    action: fields.action,
    metadata: fields.metadata,
    timestamp: fields.timestamp,
    prevHash: fields.prevHash,
    status: fields.status,
  });
  return sha256hex(canonical);
}
