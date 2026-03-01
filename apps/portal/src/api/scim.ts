import { api } from './client';

export interface ScimToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ScimTokenWithSecret extends ScimToken {
  token: string;
}

export async function listScimTokens(): Promise<ScimToken[]> {
  const res = await api.get<{ tokens: ScimToken[] }>('/v1/scim/tokens');
  return res.tokens;
}

export function createScimToken(data: {
  label: string;
}): Promise<ScimTokenWithSecret> {
  return api.post<ScimTokenWithSecret>('/v1/scim/tokens', data);
}

export function deleteScimToken(id: string): Promise<void> {
  return api.del(`/v1/scim/tokens/${encodeURIComponent(id)}`);
}
