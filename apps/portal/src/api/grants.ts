import { api } from './client';
import type { Grant } from './types';

export async function listGrants(params?: { agentId?: string; status?: string }): Promise<Grant[]> {
  const q = new URLSearchParams();
  if (params?.agentId) q.set('agentId', params.agentId);
  if (params?.status) q.set('status', params.status);
  const qs = q.toString();
  const res = await api.get<{ grants: Grant[] }>(`/v1/grants${qs ? `?${qs}` : ''}`);
  return res.grants;
}

export function getGrant(id: string): Promise<Grant> {
  return api.get<Grant>(`/v1/grants/${encodeURIComponent(id)}`);
}

export function revokeGrant(id: string): Promise<void> {
  return api.del(`/v1/grants/${encodeURIComponent(id)}`);
}
