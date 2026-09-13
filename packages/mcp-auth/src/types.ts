import type { Grantex } from '@grantex/sdk';

export interface TokenIssuedEvent {
  accessToken: string;
  clientId: string;
  scopes: string[];
  grantId: string;
  agentDid: string;
}

export interface McpAuthConfig {
  /** Grantex SDK client instance */
  grantex: Grantex;
  /** Agent ID to use for Grantex authorization */
  agentId: string;
  /** Scopes to request from Grantex */
  scopes: string[];
  /** Base URL for this auth server (used in metadata) */
  issuer: string;
  /**
   * Expected `iss` claim of Grantex grant tokens (the Grantex authorization
   * server, e.g. `https://grantex.dev`). Required for `/introspect` and
   * `/revoke`: both verify the token signature against the Grantex JWKS and
   * fail closed (503) when this is unset. This is distinct from `issuer`,
   * which is this MCP auth server's own URL and serves no JWKS.
   */
  grantexIssuer?: string;
  /** JWKS URL (defaults to `${grantexIssuer}/.well-known/jwks.json`). */
  jwksUri?: string;
  /**
   * Expected `aud` claim of introspected tokens (RFC 8707 resource
   * identifier of the MCP server). Defaults to `allowedResources` when set;
   * when neither is configured the `aud` claim is not checked.
   */
  audience?: string | string[];
  /**
   * Public URL Grantex redirects the Principal to after consent
   * (`redirectUri` sent to `POST /v1/authorize`). Must be registered on the
   * Grantex Agent. Defaults to `${issuer}${callbackPath}`.
   */
  callbackUrl?: string;
  /** Path of the consent callback route (default: `/callback`). */
  callbackPath?: string;
  /**
   * When `true`, an authorization request that Grantex auto-approves
   * (sandbox developer keys return the exchange code inline) short-circuits
   * the consent redirect and issues the client's code immediately. Off by
   * default: every authorization goes through the Grantex consent flow.
   */
  sandboxAutoApprove?: boolean;
  /** Allowed redirect URIs (optional - if empty, all are allowed) */
  allowedRedirectUris?: string[];
  /** Allowed resource indicators (RFC 8707) */
  allowedResources?: string[];
  /** Custom client store (defaults to in-memory) */
  clientStore?: ClientStore;
  /** Custom authorization code store (defaults to in-memory) */
  codeStore?: CodeStore;
  /** Custom store for authorizations awaiting Grantex consent (defaults to in-memory) */
  pendingStore?: PendingAuthorizationStore;
  /** Code expiration in seconds (default: 600) */
  codeExpirationSeconds?: number;
  /** Consent UI customization */
  consentUi?: {
    appName?: string;
    appLogo?: string;
    privacyUrl?: string;
    termsUrl?: string;
  };
  /** Lifecycle hooks */
  hooks?: {
    onTokenIssued?: (event: TokenIssuedEvent) => Promise<void>;
    onRevocation?: (jti: string) => Promise<void>;
  };
}

export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post';

export interface ClientRegistration {
  clientId: string;
  /**
   * Present only for confidential clients. When set, `/token` requires the
   * secret (constant-time compared) in addition to PKCE. Public clients
   * (`token_endpoint_auth_method: 'none'`) have no secret and are PKCE-only.
   */
  clientSecret?: string;
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  redirectUris: string[];
  grantTypes: string[];
  clientName?: string;
  createdAt: string;
}

export interface RegisterClientRequest {
  redirect_uris: string[];
  grant_types?: string[];
  client_name?: string;
  /**
   * RFC 7591 `token_endpoint_auth_method`. `none` registers a public client
   * (no secret, PKCE-only); `client_secret_basic` (default) or
   * `client_secret_post` registers a confidential client.
   */
  token_endpoint_auth_method?: TokenEndpointAuthMethod;
}

/** An OAuth authorization that is waiting for the Principal to approve it in Grantex. */
export interface PendingAuthorization {
  /** Opaque `state` sent to Grantex; the consent callback is keyed by it. */
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: string[];
  resource?: string;
  /** The client's own `state`, echoed back on the final redirect. */
  clientState?: string;
  grantexAuthRequestId: string;
  expiresAt: number;
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

export interface PendingAuthorizationStore {
  get(id: string): Promise<PendingAuthorization | undefined>;
  set(id: string, data: PendingAuthorization): Promise<void>;
  delete(id: string): Promise<boolean>;
}
