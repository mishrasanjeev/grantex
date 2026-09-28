import type { McpAuthConfig, ClientRegistration } from './types.js';
import type { McpAuthStorage } from './storage/types.js';
import { acceptedResources, canonicalResource, isLoopbackHost } from './lib/resource.js';
import { createClientMetadataResolver, isClientIdMetadataUrl, ClientMetadataError } from './lib/client-metadata.js';
import type { ClientMetadataResolver } from './lib/client-metadata.js';
import { toolPolicyFromManifests } from './resource/tool-policy.js';
import type { ToolPolicy } from './resource/tool-policy.js';
import { prepareConsentPage } from './consent/page.js';
import type { PreparedConsentPage } from './consent/page.js';

/** Everything the endpoints share, derived once from the configuration. */
export interface ServerContext {
  config: McpAuthConfig;
  storage: McpAuthStorage;
  /** Issuer without a trailing slash. */
  issuer: string;
  /** Canonical resources tokens may be issued for; never empty. */
  resources: string[];
  /** Scopes a client may request. */
  scopesSupported: string[];
  toolPolicy?: ToolPolicy;
  clientMetadata: ClientMetadataResolver;
  consentPage: PreparedConsentPage;
  /**
   * Looks a client up by id: a registered (or pre-registered) client from
   * storage, or — for an https URL id — its validated metadata document.
   * Throws {@link ClientMetadataError} when a URL id cannot be used.
   */
  getClient(clientId: string): Promise<ClientRegistration | undefined>;
}

const contexts = new WeakMap<McpAuthConfig, ServerContext>();

const PURPOSE = /^(?:[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*|x-[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9_]*)+)$/;
const DURATION = /^\d{1,6}[smhd]$/;

function assertGrantAndBranding(config: McpAuthConfig): void {
  const grant = config.grant ?? {};
  // Syntax only. Whether Grantex accepts the term is for Grantex to decide,
  // and it does not publish its purpose vocabulary in its metadata; a copy
  // here could drift from the server's. A well-formed term Grantex does not
  // accept is refused at each authorization and reported through `warn`.
  if (grant.purpose !== undefined && (typeof grant.purpose !== 'string' || grant.purpose.length > 128 || !PURPOSE.test(grant.purpose))) {
    throw new Error('createMcpAuthServer: grant.purpose must be a purpose code such as aml.cdd.onboarding or x-<org>.<term>');
  }
  if (grant.purposeDescription !== undefined && (typeof grant.purposeDescription !== 'string' || grant.purposeDescription.length > 300)) {
    throw new Error('createMcpAuthServer: grant.purposeDescription must be a string of at most 300 characters');
  }
  // POST /v1/authorize takes no data region: it builds the grant's
  // authorization_details from the purpose and scopes alone and ignores
  // any other field. A region shown on the consent page would be a
  // restriction the grant does not carry, so refuse to start rather than
  // show it.
  if (grant.dataRegion !== undefined) {
    throw new Error(
      'createMcpAuthServer: grant.dataRegion is not supported: POST /v1/authorize, which this server calls, '
      + 'takes no data region, so a grant made through it cannot carry one and the consent page cannot promise one. '
      + 'Remove grant.dataRegion.',
    );
  }
  if (grant.duration !== undefined && (typeof grant.duration !== 'string' || !DURATION.test(grant.duration))) {
    throw new Error('createMcpAuthServer: grant.duration must look like 30m, 8h or 7d');
  }
  if (grant.authorizeParams !== undefined && typeof grant.authorizeParams !== 'function') {
    throw new Error('createMcpAuthServer: grant.authorizeParams must be a function');
  }
  if (config.warn !== undefined && typeof config.warn !== 'function') {
    throw new Error('createMcpAuthServer: warn must be a function');
  }
  for (const key of ['appLogo', 'privacyUrl', 'termsUrl'] as const) {
    const value = config.consentUi?.[key];
    if (value === undefined) continue;
    let ok = false;
    try {
      ok = new URL(value).protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`createMcpAuthServer: consentUi.${key} must be an https URL`);
  }
}

function assertIssuer(issuer: unknown): string {
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new Error('createMcpAuthServer: `issuer` is required');
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`createMcpAuthServer: issuer "${issuer}" is not a URL`);
  }
  // MCP authorization, Communication Security: authorization server
  // endpoints are served over https (http is tolerated only on loopback for
  // local development).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`createMcpAuthServer: issuer must be an https URL (got ${issuer})`);
  }
  if (url.search || url.hash) {
    throw new Error('createMcpAuthServer: issuer must not have a query or fragment (RFC 8414 §2)');
  }
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

export function serverContext(config: McpAuthConfig): ServerContext {
  const existing = contexts.get(config);
  if (existing) return existing;

  const issuer = assertIssuer(config.issuer);
  const resources = acceptedResources(config);
  const toolPolicy = config.manifests !== undefined ? toolPolicyFromManifests(config.manifests) : undefined;
  const scopesSupported = [...new Set([...(config.scopes ?? []), ...(toolPolicy?.scopesSupported ?? [])])];
  if (scopesSupported.length === 0) {
    throw new Error('createMcpAuthServer: configure `scopes` or `manifests` so clients have scopes to request');
  }
  const clientMetadata = createClientMetadataResolver(config.clientIdMetadataDocuments);
  assertGrantAndBranding(config);
  if (config.resolvePrincipal !== undefined && typeof config.resolvePrincipal !== 'function') {
    throw new Error('createMcpAuthServer: resolvePrincipal must be a function');
  }
  if (config.allowLegacyClientPrincipal !== undefined && typeof config.allowLegacyClientPrincipal !== 'boolean') {
    throw new Error('createMcpAuthServer: allowLegacyClientPrincipal must be a boolean');
  }
  if (!config.resolvePrincipal && config.allowLegacyClientPrincipal !== true) {
    throw new Error('createMcpAuthServer: resolvePrincipal is required to bind consent to an authenticated human; allowLegacyClientPrincipal is an insecure evaluation-only migration opt-out');
  }
  if (!config.resolvePrincipal) {
    try {
      (config.warn ?? console.warn)('mcp-auth: allowLegacyClientPrincipal uses the OAuth client ID, not an authenticated human. Evaluation only; do not use this mode for production consent.');
    } catch { /* Logging must not change the configured authorization behavior. */ }
  }
  const consentPage = prepareConsentPage(config.consentPage);
  const storage = config.storage;

  const context: ServerContext = {
    config,
    storage,
    issuer,
    resources,
    scopesSupported,
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
    clientMetadata,
    consentPage,
    async getClient(clientId) {
      if (typeof clientId !== 'string' || clientId.length === 0) return undefined;
      if (isClientIdMetadataUrl(clientId)) return clientMetadata.resolve(clientId);
      // A URL-shaped id that is not a valid metadata URL is never looked up
      // in storage either: registered ids are opaque, not URLs.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(clientId)) {
        throw new ClientMetadataError('invalid_client_id_url', 'client_id is not a valid metadata document URL');
      }
      return storage.getClient(clientId);
    },
  };
  contexts.set(config, context);
  return context;
}

export { canonicalResource };
