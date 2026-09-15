import type { Grantex } from '@grantex/sdk';
import type { McpAuthStorage } from './storage/types.js';
import type { ClientIdMetadataDocumentOptions } from './lib/client-metadata.js';
import type { LoadedManifest } from './resource/tool-policy.js';
import type { ConsentPageOptions } from './consent/page.js';

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
  /**
   * Scopes clients may request (`scopes_supported`). A request for any other
   * scope is refused with `invalid_scope`. Optional when `manifests` is set:
   * the scopes those manifests' tools need are added automatically.
   */
  scopes?: string[];
  /**
   * Tool manifests for the MCP server this authorization server protects.
   * Scopes are derived from them (`tool:<connector>:<permission>` for each
   * tool) and the consent page lists their tools. Accepts manifest JSON in
   * the 0.5 (permission string) or 0.6 (tool object) form.
   */
  manifests?: LoadedManifest[];
  /**
   * Base URL for this auth server (used in metadata). Must be https (http is
   * accepted only for localhost) with no query or fragment.
   */
  issuer: string;
  /**
   * Canonical URI of the MCP server tokens are issued for (RFC 8707 resource
   * indicator), e.g. `https://mcp.example.com/mcp`. Required unless
   * `allowedResources` is set. Every issued token is audience-bound to the
   * requested resource and a request for any other resource is refused with
   * `invalid_target`.
   */
  resource?: string;
  /** Human-readable name of the MCP server, published in protected-resource metadata. */
  resourceName?: string;
  /** Documentation URL of the MCP server, published in protected-resource metadata. */
  resourceDocumentation?: string;
  /**
   * OAuth Client ID Metadata Documents: clients may use an https URL as
   * `client_id`, and this server fetches and validates the document it
   * serves. Enabled by default with SSRF protections; see the option type.
   */
  clientIdMetadataDocuments?: ClientIdMetadataDocumentOptions;
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
   * Expected `aud` claim of introspected and revoked tokens. Defaults to the
   * accepted resources (`resource` and `allowedResources`); it is always
   * checked.
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
  /**
   * Further resources (RFC 8707) tokens may be issued for, in addition to
   * `resource`. With more than one accepted resource, clients must send the
   * `resource` parameter.
   */
  allowedResources?: string[];
  /** Code expiration in seconds (default: 600) */
  codeExpirationSeconds?: number;
  /**
   * Branding and links shown on the consent page (and published in metadata
   * as `grantex_extensions.consent_ui_config`). `appLogo`, `privacyUrl` and
   * `termsUrl` must be https URLs.
   */
  consentUi?: {
    appName?: string;
    appLogo?: string;
    privacyUrl?: string;
    termsUrl?: string;
  };
  /**
   * The rendered consent page every authorization request shows before
   * anything is sent to Grantex (MCP authorization, Confused Deputy
   * Problem). Theme, wording and the details section are customisable; the
   * redirect host, warnings and the CSRF-protected form are not.
   */
  consentPage?: ConsentPageOptions;
  /** What the grant is for, shown on the consent page. */
  grant?: GrantOptions;
  /** Lifecycle hooks */
  hooks?: {
    onTokenIssued?: (event: TokenIssuedEvent) => Promise<void>;
    onRevocation?: (jti: string) => Promise<void>;
  };
}

export interface GrantOptions {
  /**
   * Purpose code from the controlled vocabulary, e.g. `aml.cdd.onboarding`,
   * or a private term `x-<org>.<term>`. Shown on the consent page.
   */
  purpose?: string;
  /** One-line explanation of the purpose, shown under the code. */
  purposeDescription?: string;
  /** Data region the grant is limited to, e.g. `eu`. Shown on the consent page. */
  dataRegion?: string;
  /** Grant lifetime such as `8h`, `30m` or `7d`: sent to Grantex as `expiresIn` and shown on the page. */
  duration?: string;
  /**
   * Extension point for purpose-bound grants: extra parameters merged into
   * the Grantex authorize call (for example `authorization_details` carrying
   * purpose and region once the SDK accepts them). It cannot override the
   * agent, principal, scopes, audience, redirect URI or state.
   */
  authorizeParams?: (request: { clientId: string; scopes: string[]; resource: string }) => Record<string, unknown>;
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
  /**
   * SHA-256 of the callback-binding cookie set on the browser that approved
   * the consent page. `/callback` issues a code only to that browser.
   */
  browserBindingHash?: string;
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
