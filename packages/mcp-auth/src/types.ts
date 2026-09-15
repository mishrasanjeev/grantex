import type { Grantex } from '@grantex/sdk';
import type { McpAuthStorage } from './storage/types.js';

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
   * Where every piece of authorization state lives: client registrations,
   * authorizations awaiting consent, authorization codes (with their PKCE
   * challenges), refresh-token bindings, consent records and revocations.
   *
   * Required. Use `PostgresStorage` (`@grantex/mcp-auth/postgres`) or
   * `RedisStorage` (`@grantex/mcp-auth/redis`) so state survives a restart
   * and is shared by every replica. `InMemoryStorage`
   * (`@grantex/mcp-auth/testing`) exists for tests only.
   */
  storage: McpAuthStorage;
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
   * SHA-256 of the client secret (`sha256:<base64url>`), present only for
   * confidential clients. The secret itself is returned once, at
   * registration, and never stored. When set, `/token` requires the secret
   * (compared by hash in constant time) in addition to PKCE. Public clients
   * (`token_endpoint_auth_method: 'none'`) have no secret and are PKCE-only.
   */
  clientSecretHash?: string;
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

/**
 * An OAuth authorization that is waiting for the Principal to approve it in
 * Grantex. Keyed in storage by the opaque `state` sent to Grantex.
 */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  /** PKCE S256 code challenge presented by the client. */
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: string[];
  resource?: string;
  /** The client's own `state`, echoed back on the final redirect. */
  clientState?: string;
  grantexAuthRequestId: string;
  expiresAt: number;
}

/** Keyed in storage by the authorization code handed to the client. */
export interface AuthorizationCode {
  clientId: string;
  redirectUri: string;
  /** PKCE S256 code challenge the `code_verifier` must match at `/token`. */
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: string[];
  resource?: string;
  grantexAuthRequestId: string;
  grantexCode?: string;
  expiresAt: number;
}

/**
 * Which client a refresh token was issued to (OAuth 2.1 §4.3.1 / RFC 6749
 * §6). Keyed in storage by the refresh token; the token itself is not part
 * of the record.
 */
export interface RefreshTokenBinding {
  clientId: string;
  resource?: string;
  expiresAt: number;
}

/**
 * A Principal's pending decision on the consent page for one authorization
 * request. Keyed in storage by an unguessable consent id and consumed
 * exactly once, when the consent form is submitted.
 */
export interface ConsentRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scopes: string[];
  resource?: string;
  clientState?: string;
  /** SHA-256 of the anti-CSRF token embedded in the consent form. */
  csrfTokenHash: string;
  /** SHA-256 of the browser-binding cookie set with the consent page. */
  browserBindingHash: string;
  createdAt: number;
  expiresAt: number;
}

/** A token revoked through this server. Keyed in storage by the token `jti`. */
export interface RevocationRecord {
  clientId?: string;
  revokedAt: number;
  /** When the revoked token would have expired anyway (unix ms). */
  expiresAt: number;
}
