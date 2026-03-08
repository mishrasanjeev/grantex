import { api } from './client';
import type { Domain } from './types';

export async function listDomains(): Promise<Domain[]> {
  const res = await api.get<{ domains: Domain[] }>('/v1/domains');
  return res.domains;
}

export function createDomain(domain: string): Promise<Domain> {
  return api.post<Domain>('/v1/domains', { domain });
}

export function verifyDomain(id: string): Promise<{ verified: boolean }> {
  return api.post<{ verified: boolean }>(`/v1/domains/${encodeURIComponent(id)}/verify`, {});
}

export function deleteDomain(id: string): Promise<void> {
  return api.del(`/v1/domains/${encodeURIComponent(id)}`);
}
