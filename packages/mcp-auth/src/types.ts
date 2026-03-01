import type { Grantex } from '@grantex/sdk';

export interface McpAuthConfig {
  /** Grantex SDK client instance */
  grantex: Grantex;
  /** Agent ID to use for Grantex authorization */
  agentId: string;
  /** Scopes to request from Grantex */
  scopes: string[];
  /** Base URL for this auth server (used in metadata) */
  issuer: string;
  /** Allowed redirect URIs (optional - if empty, all are allowed) */
  allowedRedirectUris?: string[];
  /** Allowed resource indicators (RFC 8707) */
  allowedResources?: string[];
  /** Custom client store (defaults to in-memory) */
  clientStore?: ClientStore;
  /** Code expiration in seconds (default: 600) */
  codeExpirationSeconds?: number;
}

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  grantTypes: string[];
  clientName?: string;
  createdAt: string;
}

export interface RegisterClientRequest {
  redirect_uris: string[];
  grant_types?: string[];
  client_name?: string;
}

export interface AuthorizationCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: string[];
  resource?: string;
  grantexAuthRequestId: string;
  grantexCode?: string;
  expiresAt: number;
}

export interface ClientStore {
  get(clientId: string): Promise<ClientRegistration | undefined>;
  set(clientId: string, registration: ClientRegistration): Promise<void>;
  delete(clientId: string): Promise<boolean>;
}

export interface CodeStore {
  get(code: string): Promise<AuthorizationCode | undefined>;
  set(code: string, data: AuthorizationCode): Promise<void>;
  delete(code: string): Promise<boolean>;
}
