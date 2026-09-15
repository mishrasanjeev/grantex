import { canonicalResource, protectedResourceMetadataPath, protectedResourceMetadataUrl } from '../lib/resource.js';

export interface ProtectedResourceMetadataOptions {
  /** Canonical URI of the MCP server. */
  resource: string;
  /** Issuers of the authorization servers that issue tokens for it (at least one). */
  authorizationServers: string[];
  /** Scopes needed for basic use. `offline_access` is dropped (not a resource requirement). */
  scopesSupported?: readonly string[];
  resourceName?: string;
  resourceDocumentation?: string;
}

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) for an MCP server. Throws
 * when the resource is not a canonical URI or no authorization server is
 * given — both are MUSTs in the MCP authorization specification.
 */
export function buildProtectedResourceMetadata(options: ProtectedResourceMetadataOptions): Record<string, unknown> {
  const resource = canonicalResource(options.resource);
  if (resource === undefined) {
    throw new Error(`Protected resource metadata: "${options.resource}" is not a valid resource URI`);
  }
  if (!Array.isArray(options.authorizationServers) || options.authorizationServers.length === 0) {
    throw new Error('Protected resource metadata: authorization_servers must list at least one authorization server');
  }
  const scopes = (options.scopesSupported ?? []).filter((scope) => scope !== 'offline_access');
  return {
    resource,
    authorization_servers: [...options.authorizationServers],
    bearer_methods_supported: ['header'],
    ...(scopes.length > 0 ? { scopes_supported: scopes } : {}),
    ...(options.resourceName !== undefined ? { resource_name: options.resourceName } : {}),
    ...(options.resourceDocumentation !== undefined ? { resource_documentation: options.resourceDocumentation } : {}),
  };
}

export { protectedResourceMetadataPath, protectedResourceMetadataUrl };
