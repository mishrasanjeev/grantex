import { api } from './client';

export interface SsoConfig {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  createdAt: string;
  updatedAt: string;
}

export function getSsoConfig(): Promise<SsoConfig> {
  return api.get<SsoConfig>('/v1/sso/config');
}

export function saveSsoConfig(data: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<SsoConfig> {
  return api.post<SsoConfig>('/v1/sso/config', data);
}

export function deleteSsoConfig(): Promise<void> {
  return api.del('/v1/sso/config');
}
