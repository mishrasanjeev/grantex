import { api } from './client';
import type { AuditEntry } from './types';

export async function listAuditEntries(params?: {
  agentId?: string;
  grantId?: string;
  principalId?: string;
  action?: string;
}): Promise<AuditEntry[]> {
  const q = new URLSearchParams();
  if (params?.agentId) q.set('agentId', params.agentId);
  if (params?.grantId) q.set('grantId', params.grantId);
  if (params?.principalId) q.set('principalId', params.principalId);
  if (params?.action) q.set('action', params.action);
  const qs = q.toString();
  const res = await api.get<{ entries: AuditEntry[] }>(`/v1/audit/entries${qs ? `?${qs}` : ''}`);
  return res.entries;
}

export function getAuditEntry(id: string): Promise<AuditEntry> {
  return api.get<AuditEntry>(`/v1/audit/${encodeURIComponent(id)}`);
}
