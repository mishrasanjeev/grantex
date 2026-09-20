/**
 * Transmitter key resolution for SET verification. A source either carries an
 * inline JWK Set or a `jwks_uri`, fetched through the SSRF-guarded outbound
 * client and cached. An unknown `kid` refetches at most once per cooldown so a
 * flood of forged tokens cannot turn into a flood of outbound requests.
 */
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';
import { config } from '../../config.js';
import { safeFetch, validateOutboundUrl, type OutboundUrlPolicy } from '../url-security.js';
import { isPlainObject } from './normalize.js';

const JWKS_TTL_MS = 5 * 60_000;
const UNKNOWN_KID_COOLDOWN_MS = 30_000;
const MAX_KEYS = 20;
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];
const ALLOWED_KTY = new Set(['RSA', 'EC', 'OKP']);

export function jwksUriPolicy(): OutboundUrlPolicy {
  return {
    allowedProtocols: ['https:', 'http:'],
    allowInsecureHttp: config.allowInsecureWebhookUrls,
    allowPrivateHosts: config.allowPrivateWebhookHosts,
  };
}

/** Validate a JWK Set supplied by a developer or fetched from a transmitter. Throws with a message. */
export function validatePublicJwks(value: unknown): JSONWebKeySet {
  if (!isPlainObject(value) || !Array.isArray(value['keys'])) {
    throw new Error('jwks must be a JWK Set object with a keys array');
  }
  const keys = value['keys'] as unknown[];
  if (keys.length === 0 || keys.length > MAX_KEYS) {
    throw new Error(`jwks must contain 1 to ${MAX_KEYS} keys`);
  }
  for (const key of keys) {
    if (!isPlainObject(key) || typeof key['kty'] !== 'string' || !ALLOWED_KTY.has(key['kty'])) {
      throw new Error('each jwks key must be an RSA, EC or OKP public key');
    }
    if (PRIVATE_MEMBERS.some((member) => member in key)) {
      throw new Error('jwks must contain public keys only');
    }
  }
  return { keys: keys as JSONWebKeySet['keys'] };
}

interface CachedJwks {
  keySet: JSONWebKeySet;
  fetchedAt: number;
}

const remoteCache = new Map<string, CachedJwks>();
const lastRefresh = new Map<string, number>();

export function clearEventSourceJwksCache(): void {
  remoteCache.clear();
  lastRefresh.clear();
}

async function fetchJwks(uri: string): Promise<JSONWebKeySet> {
  const policy = jwksUriPolicy();
  validateOutboundUrl(uri, policy);
  const res = await safeFetch(uri, { headers: { accept: 'application/json' } }, policy);
  if (!res.ok) throw new Error(`transmitter JWK Set returned HTTP ${res.status}`);
  return validatePublicJwks(await res.json());
}

export interface KeySourceConfig {
  id: string;
  jwksUri: string | null;
  jwks: unknown;
}

/** A jose key resolver for one source. Inline keys win over a URI. */
export function keyResolverFor(source: KeySourceConfig, now: () => number = Date.now): JWTVerifyGetKey {
  if (source.jwks !== null && source.jwks !== undefined) {
    return createLocalJWKSet(validatePublicJwks(source.jwks));
  }
  const uri = source.jwksUri;
  if (!uri) {
    return async () => {
      throw new Error('source has no transmitter keys');
    };
  }
  const cacheKey = `${source.id}|${uri}`;
  return async (header, token) => {
    let cached = remoteCache.get(cacheKey);
    if (!cached || now() - cached.fetchedAt > JWKS_TTL_MS) {
      cached = { keySet: await fetchJwks(uri), fetchedAt: now() };
      remoteCache.set(cacheKey, cached);
      lastRefresh.set(cacheKey, now());
    }
    try {
      return await createLocalJWKSet(cached.keySet)(header, token);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const last = lastRefresh.get(cacheKey) ?? 0;
      if (code !== 'ERR_JWKS_NO_MATCHING_KEY' || now() - last < UNKNOWN_KID_COOLDOWN_MS) throw err;
      lastRefresh.set(cacheKey, now());
      cached = { keySet: await fetchJwks(uri), fetchedAt: now() };
      remoteCache.set(cacheKey, cached);
      return createLocalJWKSet(cached.keySet)(header, token);
    }
  };
}
