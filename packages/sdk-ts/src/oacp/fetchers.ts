/**
 * Network sources for `verifyOacpArtifact`: the issuer's JWK Set and its
 * Token Status Lists. Both are bound to URLs the relying party configures;
 * neither ever follows a URL taken from an artifact outside those bounds, and
 * neither follows redirects.
 */
import type { OacpJwks } from './jose.js';
import { STATUS_LIST_TOKEN_MEDIA_TYPE } from './status-list.js';

/** Deadline for one fetch, headers and body, in milliseconds. */
export const OACP_FETCH_TIMEOUT_MS = 5_000;
/** Largest JWK Set read, in bytes. */
export const OACP_JWKS_MAX_BYTES = 64 * 1024;
/** Largest Status List Token read, in bytes. */
export const OACP_STATUS_LIST_MAX_BYTES = 1024 * 1024;
/** The longest a JWK Set is reused before it is fetched again, in milliseconds. */
export const OACP_JWKS_CACHE_MS = 10 * 60 * 1000;
/** An unknown kid refetches the JWK Set at most this often, in milliseconds. */
export const OACP_JWKS_REFRESH_COOLDOWN_MS = 30 * 1000;
/** The longest a Status List Token is reused, whatever its `ttl`, in seconds. */
export const OACP_STATUS_LIST_MAX_CACHE_SECONDS = 600;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Returns the issuer's JWK Set; `refresh` asks for a fresh copy (an unknown kid). */
export type OacpJwksSource = OacpJwks | ((options?: { refresh?: boolean }) => Promise<OacpJwks>);

/** Returns the Status List Token text served at `uri`. Throws when it cannot. */
export type OacpStatusListFetcher = (uri: string) => Promise<string>;

async function boundedText(fetchImpl: FetchLike, url: string, maxBytes: number, accept: (contentType: string) => boolean): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OACP_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json, application/jwk-set+json, application/statuslist+jwt' } });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${url} answered HTTP ${response.status}`);
    }
    if (!accept((response.headers.get('content-type') ?? '').toLowerCase())) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${url} answered an unexpected content type`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${url} is larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

function mediaType(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim();
}

function requireHttps(value: string, allowLoopbackHttp: boolean, what: string): URL {
  const url = new URL(value);
  if (url.protocol === 'https:') return url;
  if (allowLoopbackHttp && url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  throw new Error(`${what} must be an https URL`);
}

/** localhost, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

export interface OacpJwksFetcherOptions {
  /** The pinned issuer identifier (the auth service's `JWT_ISSUER`). */
  issuer: string;
  /** Where its JWK Set is served. Default `<issuer>/.well-known/jwks.json`. */
  jwksUri?: string;
  /** Accept plain http on loopback hosts (local development only). Default false. */
  allowLoopbackHttp?: boolean;
  fetch?: FetchLike;
}

/**
 * A JWK Set source bound to the pinned issuer's JWKS URI: cached for ten
 * minutes, refetched for an unknown kid at most every 30 seconds, HTTP 200
 * only, `application/json` or `application/jwk-set+json`, at most 64 KiB, no
 * redirects.
 */
export function createOacpJwksFetcher(options: OacpJwksFetcherOptions): (options?: { refresh?: boolean }) => Promise<OacpJwks> {
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const issuerUrl = requireHttps(options.issuer, allowLoopbackHttp, 'issuer');
  const jwksUri = requireHttps(
    options.jwksUri ?? `${issuerUrl.href.replace(/\/+$/, '')}/.well-known/jwks.json`,
    allowLoopbackHttp,
    'jwksUri',
  ).href;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  let cached: { jwks: OacpJwks; at: number } | null = null;
  return async (call) => {
    const now = Date.now();
    const fresh = cached !== null && now - cached.at < OACP_JWKS_CACHE_MS;
    const mayRefresh = cached === null || now - cached.at >= OACP_JWKS_REFRESH_COOLDOWN_MS;
    if (cached !== null && fresh && !(call?.refresh === true && mayRefresh)) return cached.jwks;
    const text = await boundedText(fetchImpl, jwksUri, OACP_JWKS_MAX_BYTES, (type) =>
      ['application/json', 'application/jwk-set+json'].includes(mediaType(type)));
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as OacpJwks).keys)) {
      throw new Error(`${jwksUri} is not a JWK Set`);
    }
    cached = { jwks: parsed as OacpJwks, at: now };
    return cached.jwks;
  };
}

export interface OacpStatusListFetcherOptions {
  /**
   * URI prefixes the relying party trusts to serve status lists, normally
   * `<issuer>/status/oacp/`. A status URI outside them is refused.
   */
  allowedPrefixes: string[];
  /** Accept plain http on loopback hosts (local development only). Default false. */
  allowLoopbackHttp?: boolean;
  /** Reuse a list for at most its `ttl` and never longer than this. Default 600 s; 0 disables reuse. */
  maxCacheSeconds?: number;
  fetch?: FetchLike;
}

function unverifiedTtlSeconds(token: string): number | null {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { ttl?: unknown; exp?: unknown };
    const ttl = typeof claims.ttl === 'number' && Number.isSafeInteger(claims.ttl) && claims.ttl > 0 ? claims.ttl : null;
    if (ttl === null) return null;
    if (typeof claims.exp === 'number') return Math.min(ttl, Math.max(0, Math.floor(claims.exp - Date.now() / 1000)));
    return ttl;
  } catch {
    return null;
  }
}

/**
 * A status-list source restricted to `allowedPrefixes`. It caches each list
 * for no longer than the list's `ttl` (draft-ietf-oauth-status-list §13.7);
 * the verifier still checks the signature and freshness of every copy, so a
 * cached list never outlives its `exp`.
 */
export function createOacpStatusListFetcher(options: OacpStatusListFetcherOptions): OacpStatusListFetcher & { clear(): void } {
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const prefixes = options.allowedPrefixes.map((prefix) => requireHttps(prefix, allowLoopbackHttp, 'allowed prefix').href);
  if (prefixes.length === 0) throw new Error('createOacpStatusListFetcher needs at least one allowed prefix');
  const maxCacheSeconds = options.maxCacheSeconds ?? OACP_STATUS_LIST_MAX_CACHE_SECONDS;
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const cache = new Map<string, { token: string; until: number }>();
  const fetcher = async (uri: string): Promise<string> => {
    const url = requireHttps(uri, allowLoopbackHttp, 'status list URI');
    if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw new Error('status list URI must not carry a query, fragment or credentials');
    }
    if (!prefixes.some((prefix) => url.href.startsWith(prefix))) {
      throw new Error('status list URI is outside the configured issuer prefixes');
    }
    const hit = cache.get(url.href);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = (await boundedText(fetchImpl, url.href, OACP_STATUS_LIST_MAX_BYTES, (type) =>
      mediaType(type) === STATUS_LIST_TOKEN_MEDIA_TYPE)).trim();
    const ttl = unverifiedTtlSeconds(token);
    if (ttl !== null && maxCacheSeconds > 0) {
      cache.set(url.href, { token, until: Date.now() + Math.min(ttl, maxCacheSeconds) * 1000 });
    } else {
      cache.delete(url.href);
    }
    return token;
  };
  return Object.assign(fetcher, { clear: () => cache.clear() });
}
