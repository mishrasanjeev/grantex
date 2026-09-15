/**
 * Resource indicators (RFC 8707) and the URL rules the MCP authorization
 * specification places on them.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for `localhost`, `127.0.0.1` and `[::1]` (URL.hostname form). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Canonical form of an MCP server URI (MCP authorization, "Canonical Server
 * URI"): an absolute `https` URL — or `http` on a loopback host — with no
 * fragment and no user information. Scheme and host are lower-cased, a
 * default port is dropped and a bare trailing `/` is removed, so
 * `HTTPS://MCP.Example.com/` and `https://mcp.example.com` compare equal.
 * Returns `undefined` for anything else.
 */
export function canonicalResource(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return undefined;
  if (value.includes('#')) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) return undefined;
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/**
 * The resources this server issues tokens for, canonicalised. Throws when a
 * configured value is not a valid resource URI or when none is configured:
 * audience binding is mandatory, so an unbound deployment must not start.
 */
export function acceptedResources(config: { resource?: string; allowedResources?: string[] }): string[] {
  const configured = [
    ...(config.resource !== undefined ? [config.resource] : []),
    ...(config.allowedResources ?? []),
  ];
  if (configured.length === 0) {
    throw new Error(
      'createMcpAuthServer: `resource` is required — the canonical URI of the MCP server tokens are issued for '
      + '(for example https://mcp.example.com/mcp). Tokens are always audience-bound to it (RFC 8707).',
    );
  }
  const accepted: string[] = [];
  for (const value of configured) {
    const canonical = canonicalResource(value);
    if (canonical === undefined) {
      throw new Error(
        `createMcpAuthServer: resource "${value}" is not a valid resource URI `
        + '(absolute https URL, or http on localhost, with no fragment)',
      );
    }
    if (!accepted.includes(canonical)) accepted.push(canonical);
  }
  return accepted;
}

export type ResourceResolution =
  | { ok: true; resource: string }
  | { ok: false; description: string };

/**
 * Resolves the `resource` parameter of an authorization or token request
 * against the accepted set. An absent parameter falls back to the only
 * accepted resource; with several, the request is ambiguous and refused.
 */
export function resolveRequestedResource(requested: unknown, accepted: readonly string[]): ResourceResolution {
  if (Array.isArray(requested)) {
    return { ok: false, description: 'Exactly one resource parameter is supported' };
  }
  if (requested === undefined || requested === '') {
    if (accepted.length === 1) return { ok: true, resource: accepted[0]! };
    return { ok: false, description: 'resource is required: this server issues tokens for more than one resource' };
  }
  const canonical = canonicalResource(requested);
  if (canonical === undefined) {
    return { ok: false, description: 'resource must be an absolute https URI without a fragment' };
  }
  if (!accepted.includes(canonical)) {
    return { ok: false, description: 'Resource not in allow-list' };
  }
  return { ok: true, resource: canonical };
}

/**
 * RFC 9728 §3.1: the metadata URL for a resource inserts
 * `/.well-known/oauth-protected-resource` between the host and the path.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const canonical = canonicalResource(resource);
  if (canonical === undefined) throw new Error(`Not a valid resource URI: ${resource}`);
  const url = new URL(canonical);
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}/.well-known/oauth-protected-resource${path}${url.search}`;
}

/** The path (no origin) at which the protected-resource metadata for `resource` is served. */
export function protectedResourceMetadataPath(resource: string): string {
  return new URL(protectedResourceMetadataUrl(resource)).pathname;
}
