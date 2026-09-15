import type { McpAuthConfig, ClientRegistration } from './types.js';
import type { McpAuthStorage } from './storage/types.js';
import { acceptedResources, canonicalResource, isLoopbackHost } from './lib/resource.js';
import { createClientMetadataResolver, isClientIdMetadataUrl, ClientMetadataError } from './lib/client-metadata.js';
import type { ClientMetadataResolver } from './lib/client-metadata.js';
import { toolPolicyFromManifests } from './resource/tool-policy.js';
import type { ToolPolicy } from './resource/tool-policy.js';

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
  /**
   * Looks a client up by id: a registered (or pre-registered) client from
   * storage, or — for an https URL id — its validated metadata document.
   * Throws {@link ClientMetadataError} when a URL id cannot be used.
   */
  getClient(clientId: string): Promise<ClientRegistration | undefined>;
}

const contexts = new WeakMap<McpAuthConfig, ServerContext>();

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
  const storage = config.storage;

  const context: ServerContext = {
    config,
    storage,
    issuer,
    resources,
    scopesSupported,
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
    clientMetadata,
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
