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

// ── Enterprise SSO Connections ──────────────────────────────────────────

export interface SsoConnection {
  id: string;
  developerId: string;
  name: string;
  protocol: 'oidc' | 'saml' | 'ldap';
  status: 'active' | 'inactive' | 'testing';
  domains: string[];
  jitProvisioning: boolean;
  enforce: boolean;
  // OIDC
  issuerUrl?: string;
  clientId?: string;
  // SAML
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpCertificate?: string;
  spEntityId?: string;
  spAcsUrl?: string;
  // LDAP
  ldapUrl?: string;
  ldapBindDn?: string;
  ldapSearchBase?: string;
  ldapSearchFilter?: string;
  ldapGroupSearchBase?: string;
  ldapGroupSearchFilter?: string;
  ldapTlsEnabled?: boolean;
  // Common
  groupAttribute?: string;
  groupMappings?: Record<string, string[]>;
  defaultScopes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionData {
  name: string;
  protocol: 'oidc' | 'saml' | 'ldap';
  domains?: string[];
  jitProvisioning?: boolean;
  enforce?: boolean;
  // OIDC
  issuerUrl?: string;
  clientId?: string;
  clientSecret?: string;
  // SAML
  idpEntityId?: string;
  idpSsoUrl?: string;
  idpCertificate?: string;
  spEntityId?: string;
  spAcsUrl?: string;
  // LDAP
  ldapUrl?: string;
  ldapBindDn?: string;
  ldapBindPassword?: string;
  ldapSearchBase?: string;
  ldapSearchFilter?: string;
  ldapGroupSearchBase?: string;
  ldapGroupSearchFilter?: string;
  ldapTlsEnabled?: boolean;
}

export interface TestResult {
  success: boolean;
  protocol: string;
  error?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  idpEntityId?: string;
  idpSsoUrl?: string;
  ldapUrl?: string;
  ldapSearchBase?: string;
}

export function listSsoConnections(): Promise<{ connections: SsoConnection[] }> {
  return api.get<{ connections: SsoConnection[] }>('/v1/sso/connections');
}

export function createSsoConnection(data: CreateConnectionData): Promise<SsoConnection> {
  return api.post<SsoConnection>('/v1/sso/connections', data);
}

export function deleteSsoConnection(id: string): Promise<void> {
  return api.del(`/v1/sso/connections/${id}`);
}

export function testSsoConnection(id: string): Promise<TestResult> {
  return api.post<TestResult>(`/v1/sso/connections/${id}/test`);
}
