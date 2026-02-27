import { api } from './client';
import type { Grant } from './types';

export function listGrants(params?: { agentId?: string; status?: string }): Promise<Grant[]> {
  const q = new URLSearchParams();
  if (params?.agentId) q.set('agentId', params.agentId);
  if (params?.status) q.set('status', params.status);
  const qs = q.toString();
  return api.get<Grant[]>(`/v1/grants${qs ? `?${qs}` : ''}`);
}

export function getGrant(id: string): Promise<Grant> {
  return api.get<Grant>(`/v1/grants/${encodeURIComponent(id)}`);
}

export function revokeGrant(id: string): Promise<void> {
  return api.post<void>(`/v1/grants/${encodeURIComponent(id)}/revoke`);
}
