import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import type { ClientRegistration } from '../types.js';
import { isPublicAddress } from './address-policy.js';
import { isLoopbackHost } from './resource.js';

/**
 * OAuth Client ID Metadata Documents
 * (draft-ietf-oauth-client-id-metadata-document-00), as profiled by the MCP
 * authorization specification: a client identifies itself with an https URL
 * that serves its metadata, and the authorization server fetches it.
 *
 * The fetch is an outbound request to a URL an unauthenticated party chose,
 * so it is treated as hostile: https only; every resolved address must be
 * public and the connection is pinned to the vetted address (no DNS
 * rebinding); redirects are not followed; the response is bounded in size
 * and time; and anything unexpected fails closed with a reason code.
 */

export type ClientMetadataFailure =
  | 'invalid_client_id_url'
  | 'disabled'
  | 'host_not_trusted'
  | 'port_not_allowed'
  | 'dns_failed'
  | 'address_not_allowed'
  | 'fetch_failed'
  | 'fetch_timeout'
  | 'redirect_not_followed'
  | 'http_status'
  | 'too_large'
  | 'invalid_content_type'
  | 'invalid_json'
  | 'client_id_mismatch'
  | 'invalid_metadata'
  | 'invalid_redirect_uri'
  | 'unsupported_auth_method';

export class ClientMetadataError extends Error {
  readonly reason: ClientMetadataFailure;

  constructor(reason: ClientMetadataFailure, message: string) {
    super(message);
    this.name = 'ClientMetadataError';
    this.reason = reason;
  }
}

export interface ClientIdMetadataDocumentOptions {
  /** Accept URL client identifiers at all (default `true`). */
  enabled?: boolean;
  /**
   * Domain trust policy. When set, only these hosts may serve metadata
   * documents: an exact host (`app.example.com`) or a suffix wildcard
   * (`*.example.com`, which does not match `example.com` itself).
   */
  allowedHosts?: string[];
  /**
   * Ports metadata documents may be fetched from (default `[443]`). Allow
   * another port only for a host you trust: a port is how a fetch reaches
   * services that are not web servers.
   */
  allowedPorts?: number[];
  /** Whole-request deadline in milliseconds (default 5000, at most 30000). */
  timeoutMs?: number;
  /** Maximum document size in bytes (default 16384, at most 1048576). */
  maxBytes?: number;
  /** Cache lifetime when the response sets none (seconds, default 300). */
  cacheTtlSeconds?: number;
  /** Upper bound on any cache lifetime, including `Cache-Control: max-age` (seconds, default 86400). */
  maxCacheTtlSeconds?: number;
}

/** Test seams. Not part of the public configuration. */
export interface ClientMetadataInternals {
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  isAddressAllowed?: (address: string) => boolean;
  ca?: string | Buffer;
  now?: () => number;
}

const MAX_CACHE_ENTRIES = 1000;
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;

/**
 * Whether `clientId` has the shape of a metadata-document client identifier:
 * an https URL with a path, no fragment, no credentials and no dot segments.
 */
export function isClientIdMetadataUrl(clientId: unknown): clientId is string {
  if (typeof clientId !== 'string' || !clientId.startsWith('https://') || clientId.length > 2048) return false;
  if (clientId.includes('#')) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  // URL parsing resolves dot segments away, so inspect the path as sent.
  const afterScheme = clientId.slice('https://'.length);
  const slash = afterScheme.indexOf('/');
  const rawPath = slash === -1 ? '' : (afterScheme.slice(slash).split('?')[0] ?? '');
  if (url.username || url.password) return false;
  if (url.pathname === '/' || url.pathname === '') return false;
  if (DOT_SEGMENT.test(rawPath) || /%2e/i.test(rawPath)) return false;
  return true;
}

function hostAllowed(hostname: string, allowedHosts: string[] | undefined): boolean {
  if (allowedHosts === undefined) return true;
  const host = hostname.toLowerCase();
  return allowedHosts.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
    return host === p;
  });
}

function parseMaxAge(cacheControl: string | undefined): { noStore: boolean; maxAge?: number } {
  if (!cacheControl) return { noStore: false };
  const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim());
  if (directives.some((d) => d === 'no-store' || d === 'no-cache' || d === 'private')) return { noStore: true };
  const maxAge = directives.find((d) => d.startsWith('max-age='));
  const seconds = maxAge ? Number(maxAge.slice(8)) : Number.NaN;
  return Number.isInteger(seconds) && seconds >= 0 ? { noStore: false, maxAge: seconds } : { noStore: false };
}

/** Redirect URIs must be https, or http on a loopback host, with no fragment or credentials. */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048 || value.includes('#')) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    // MCP authorization, Communication Security: redirect URIs are either
    // localhost or https.
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

/** Validates a fetched document and maps it to a public client registration. */
export function parseClientMetadataDocument(clientId: string, document: unknown, now: number): ClientRegistration {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ClientMetadataError('invalid_json', 'Client metadata document is not a JSON object');
  }
  const doc = document as Record<string, unknown>;
  if (doc['client_id'] !== clientId) {
    throw new ClientMetadataError('client_id_mismatch', 'client_id in the metadata document does not exactly match its URL');
  }
  const clientName = doc['client_name'];
  if (typeof clientName !== 'string' || clientName.trim().length === 0 || clientName.length > 200) {
    throw new ClientMetadataError('invalid_metadata', 'client_name is required (a non-empty string of at most 200 characters)');
  }
  const redirectUris = doc['redirect_uris'];
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20) {
    throw new ClientMetadataError('invalid_metadata', 'redirect_uris is required (1 to 20 URIs)');
  }
  if (!redirectUris.every(isAllowedRedirectUri)) {
    throw new ClientMetadataError('invalid_redirect_uri', 'Every redirect URI must be https, or http on localhost, without a fragment');
  }
  if ('client_secret' in doc || 'client_secret_expires_at' in doc) {
    throw new ClientMetadataError('unsupported_auth_method', 'A client metadata document must not carry a client secret');
  }
  const authMethod = doc['token_endpoint_auth_method'] ?? 'none';
  if (authMethod !== 'none') {
    throw new ClientMetadataError(
      'unsupported_auth_method',
      `token_endpoint_auth_method "${String(authMethod)}" is not supported for metadata-document clients; use "none" with PKCE`,
    );
  }
  const grantTypes = doc['grant_types'] ?? ['authorization_code'];
  if (
    !Array.isArray(grantTypes)
    || grantTypes.length === 0
    || !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')
  ) {
    throw new ClientMetadataError('invalid_metadata', 'grant_types may contain only authorization_code and refresh_token');
  }
  const responseTypes = doc['response_types'];
  if (responseTypes !== undefined && (!Array.isArray(responseTypes) || !responseTypes.includes('code'))) {
    throw new ClientMetadataError('invalid_metadata', 'response_types must include "code"');
  }
  return {
    clientId,
    clientName: clientName.trim(),
    redirectUris: [...redirectUris],
    grantTypes: [...(grantTypes as string[])],
    tokenEndpointAuthMethod: 'none',
    createdAt: new Date(now).toISOString(),
  };
}

interface CacheEntry {
  client: ClientRegistration;
  expiresAt: number;
}

export interface ClientMetadataResolver {
  readonly enabled: boolean;
  /** Fetches (or serves from cache) and validates the document; throws {@link ClientMetadataError}. */
  resolve(clientId: string): Promise<ClientRegistration>;
}

export function createClientMetadataResolver(
  options: ClientIdMetadataDocumentOptions = {},
  internals: ClientMetadataInternals = {},
): ClientMetadataResolver {
  const enabled = options.enabled ?? true;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5000, 100), 30_000);
  const maxBytes = Math.min(Math.max(options.maxBytes ?? 16_384, 256), 1_048_576);
  const maxTtlMs = Math.max(0, options.maxCacheTtlSeconds ?? 86_400) * 1000;
  const defaultTtlMs = Math.min(Math.max(0, options.cacheTtlSeconds ?? 300) * 1000, maxTtlMs);
  const resolveHost = internals.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const isAddressAllowed = internals.isAddressAllowed ?? isPublicAddress;
  const now = internals.now ?? Date.now;
  const allowedPorts = options.allowedPorts ?? [443];
  if (!Array.isArray(allowedPorts) || !allowedPorts.every((port) => Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new Error('clientIdMetadataDocuments.allowedPorts must be a list of TCP port numbers');
  }
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ClientRegistration>>();

  async function vettedAddress(hostname: string): Promise<{ address: string; family: number }> {
    const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    let addresses: Array<{ address: string; family: number }>;
    if (isIP(bare) !== 0) {
      addresses = [{ address: bare, family: isIP(bare) }];
    } else {
      try {
        addresses = await resolveHost(bare);
      } catch (err) {
        throw new ClientMetadataError('dns_failed', `Could not resolve ${bare}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (addresses.length === 0) throw new ClientMetadataError('dns_failed', `No addresses for ${bare}`);
    // Refuse if any address is not public: a name that resolves to a private
    // address is not trusted even if it also has a public one.
    const refused = addresses.find((entry) => !isAddressAllowed(entry.address));
    if (refused) {
      throw new ClientMetadataError('address_not_allowed', `${bare} resolves to a non-public address`);
    }
    return addresses[0]!;
  }

  function fetchDocument(url: URL, pinned: { address: string; family: number }): Promise<{ body: string; cacheControl?: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: ClientMetadataError | undefined, value?: { body: string; cacheControl?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (err) reject(err);
        else resolve(value!);
      };
      // The connection goes to the address vetted above, never to a fresh
      // DNS answer, so a rebinding resolver cannot redirect it.
      const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
        if ((lookupOptions as { all?: boolean }).all) {
          (callback as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [pinned]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      };
      const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
      const req = httpsRequest(
        {
          protocol: 'https:',
          hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': 'grantex-mcp-auth (client-id-metadata-document)' },
          lookup,
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
          ...(internals.ca !== undefined ? { ca: internals.ca } : {}),
          agent: false,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            finish(new ClientMetadataError('redirect_not_followed', `Metadata document request was redirected (HTTP ${status})`));
            return;
          }
          if (status !== 200) {
            res.destroy();
            finish(new ClientMetadataError('http_status', `Metadata document request returned HTTP ${status}`));
            return;
          }
          const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
          if (contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
            res.destroy();
            finish(new ClientMetadataError('invalid_content_type', `Metadata document has content type "${contentType || 'none'}"`));
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.destroy();
            finish(new ClientMetadataError('too_large', `Metadata document exceeds ${maxBytes} bytes`));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              res.destroy();
              finish(new ClientMetadataError('too_large', `Metadata document exceeds ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const cacheControl = res.headers['cache-control'];
            finish(undefined, {
              body: Buffer.concat(chunks).toString('utf8'),
              ...(typeof cacheControl === 'string' ? { cacheControl } : {}),
            });
          });
          res.on('error', (err) => finish(new ClientMetadataError('fetch_failed', `Metadata document request failed: ${err.message}`)));
        },
      );
      const deadline = setTimeout(() => {
        req.destroy();
        finish(new ClientMetadataError('fetch_timeout', `Metadata document request exceeded ${timeoutMs} ms`));
      }, timeoutMs);
      req.on('error', (err) => finish(new ClientMetadataError('fetch_failed', `Metadata document request failed: ${err.message}`)));
      req.end();
    });
  }

  async function load(clientId: string): Promise<ClientRegistration> {
    const url = new URL(clientId);
    if (!hostAllowed(url.hostname, options.allowedHosts)) {
      throw new ClientMetadataError('host_not_trusted', `${url.hostname} is not in the client metadata trust policy`);
    }
    const port = url.port === '' ? 443 : Number(url.port);
    if (!allowedPorts.includes(port)) {
      throw new ClientMetadataError('port_not_allowed', `Metadata documents are not fetched from port ${port}`);
    }
    const pinned = await vettedAddress(url.hostname);
    const { body, cacheControl } = await fetchDocument(url, pinned);
    let document: unknown;
    try {
      document = JSON.parse(body);
    } catch {
      throw new ClientMetadataError('invalid_json', 'Metadata document is not valid JSON');
    }
    const client = parseClientMetadataDocument(clientId, document, now());
    const { noStore, maxAge } = parseMaxAge(cacheControl);
    const ttl = noStore ? 0 : Math.min(maxAge !== undefined ? maxAge * 1000 : defaultTtlMs, maxTtlMs);
    if (ttl > 0) {
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
      cache.set(clientId, { client, expiresAt: now() + ttl });
    }
    return client;
  }

  return {
    enabled,
    async resolve(clientId) {
      if (!enabled) throw new ClientMetadataError('disabled', 'URL client identifiers are not accepted by this server');
      if (!isClientIdMetadataUrl(clientId)) {
        throw new ClientMetadataError('invalid_client_id_url', 'client_id is not a valid metadata document URL');
      }
      const cached = cache.get(clientId);
      if (cached && cached.expiresAt > now()) return structuredClone(cached.client);
      if (cached) cache.delete(clientId);
      let pending = inFlight.get(clientId);
      if (!pending) {
        pending = load(clientId).finally(() => inFlight.delete(clientId));
        inFlight.set(clientId, pending);
      }
      return structuredClone(await pending);
    },
  };
}
