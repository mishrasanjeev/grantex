import { api } from './client';
import type { AuditEntry } from './types';

export function listAuditEntries(params?: {
  action?: string;
  resourceType?: string;
  limit?: number;
}): Promise<AuditEntry[]> {
  const q = new URLSearchParams();
  if (params?.action) q.set('action', params.action);
  if (params?.resourceType) q.set('resourceType', params.resourceType);
  if (params?.limit) q.set('limit', String(params.limit));
  const qs = q.toString();
  return api.get<AuditEntry[]>(`/v1/audit/entries${qs ? `?${qs}` : ''}`);
}

export function getAuditEntry(id: string): Promise<AuditEntry> {
  return api.get<AuditEntry>(`/v1/audit/${encodeURIComponent(id)}`);
}
