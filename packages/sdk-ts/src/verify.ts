import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { missingScopes } from './scopes.js';
import { GrantexTokenError } from './errors.js';
import type { VerifiedGrant, VerifyGrantTokenOptions, GrantTokenPayload } from './types.js';

/**
 * Signature algorithms a grant token may use. Each maps to one key type (RSA
 * for RS256, EC P-256 for ES256), and JOSE only selects a JWK Set key of that
 * type, published for that algorithm, under the token's `kid`. `none`, the
 * HMAC family and every other algorithm are refused.
 */
export const GRANT_TOKEN_ALGORITHMS = ['RS256', 'ES256'] as const;
export type GrantTokenAlgorithm = (typeof GRANT_TOKEN_ALGORITHMS)[number];

function resolveAlgorithms(requested: readonly string[] | undefined): string[] {
  if (requested === undefined) return [...GRANT_TOKEN_ALGORITHMS];
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new GrantexTokenError('algorithms must list at least one of RS256, ES256');
  }
  const unsupported = requested.filter(
    (alg) => !(GRANT_TOKEN_ALGORITHMS as readonly string[]).includes(alg),
  );
  if (unsupported.length > 0) {
    throw new GrantexTokenError(
      `Unsupported grant token algorithm ${unsupported.map(String).join(', ')}; allowed: ${GRANT_TOKEN_ALGORITHMS.join(', ')}`,
    );
  }
  return [...new Set(requested)];
}

const PRODUCTION_JWKS_URI = 'https://api.grantex.dev/.well-known/jwks.json';
const PRODUCTION_ISSUER = 'https://grantex.dev';
const MAX_REMOTE_JWKS_RESOLVERS = 64;

type RemoteJwksResolver = ReturnType<typeof createRemoteJWKSet>;

// A createRemoteJWKSet resolver owns JOSE's key cache, cooldown, and unknown-kid
// refresh behavior. Reusing it is both faster and safer than rebuilding an
// empty cache for every verification. The bounded LRU prevents tenant-provided
// JWKS URLs from growing process memory without limit.
const remoteJwksResolvers = new Map<string, RemoteJwksResolver>();

function getRemoteJwksResolver(jwksUrl: URL): RemoteJwksResolver {
  const cacheKey = jwksUrl.href;
  const cached = remoteJwksResolvers.get(cacheKey);
  if (cached !== undefined) {
    remoteJwksResolvers.delete(cacheKey);
    remoteJwksResolvers.set(cacheKey, cached);
    return cached;
  }

  const resolver = createRemoteJWKSet(jwksUrl);
  if (remoteJwksResolvers.size >= MAX_REMOTE_JWKS_RESOLVERS) {
    const oldest = remoteJwksResolvers.keys().next().value as string | undefined;
    if (oldest !== undefined) remoteJwksResolvers.delete(oldest);
  }
  remoteJwksResolvers.set(cacheKey, resolver);
  return resolver;
}

/** @internal Clear process-level JWKS resolvers. Intended for deterministic tests. */
export function clearRemoteJwksCache(): void {
  remoteJwksResolvers.clear();
}

/**
 * Verify a Grantex grant token locally using JWKS retrieved from the configured URI.
 * The signature must be RS256 or ES256 (`GRANT_TOKEN_ALGORITHMS`); `options.algorithms`
 * can narrow that list but never widen it.
 *
 * @throws {GrantexTokenError} if the token is invalid, expired, or missing required scopes.
 */
export async function verifyGrantToken(
  token: string,
  options: VerifyGrantTokenOptions,
): Promise<VerifiedGrant> {
  const algorithms = resolveAlgorithms(options.algorithms);
  let jwksUri = options.jwksUri;
  let expectedIssuer = options.issuer;
  if (options.issuerDid?.startsWith('did:web:')) {
    const domain = options.issuerDid.replace('did:web:', '').replaceAll(':', '/');
    jwksUri = `https://${domain}/.well-known/jwks.json`;
    expectedIssuer ??= `https://${domain}`;
  }
  const jwksUrl = new URL(jwksUri);
  // Fragments are not sent in HTTP requests and therefore must not create
  // duplicate cache entries for the same JWKS resource.
  jwksUrl.hash = '';
  if (expectedIssuer === undefined) {
    if (jwksUrl.href.replace(/\/$/, '') === PRODUCTION_JWKS_URI) {
      expectedIssuer = PRODUCTION_ISSUER;
    } else {
      expectedIssuer = jwksUrl.pathname.endsWith('/.well-known/jwks.json')
        ? `${jwksUrl.origin}${jwksUrl.pathname.slice(0, -'/.well-known/jwks.json'.length)}`
        : `${jwksUrl.origin}${jwksUrl.pathname.replace(/\/$/, '')}`;
    }
  }
  const jwks = getRemoteJwksResolver(jwksUrl);

  let payload: GrantTokenPayload;
  try {
    const jwtOptions = {
      algorithms,
      issuer: expectedIssuer,
      ...(options.clockTolerance !== undefined
        ? { clockTolerance: options.clockTolerance }
        : {}),
      ...(options.audience !== undefined
        ? { audience: options.audience }
        : {}),
    };
    const result = await jwtVerify(token, jwks, jwtOptions);
    payload = result.payload as unknown as GrantTokenPayload;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    throw new GrantexTokenError(`Grant token verification failed: ${message}`);
  }

  // Validate the claim shape before touching `scp`. A signed-but-foreign JWT
  // from the same issuer (e.g. a session or OAuth access token) may carry no
  // `scp`, or a string `scp` on which `.includes()` degrades to a substring
  // match. Either way this must surface as a GrantexTokenError, not a
  // TypeError or a false positive.
  const verified = payloadToVerifiedGrant(payload);

  const requiredScopes = options.requiredScopes ?? [];
  if (requiredScopes.length > 0) {
    const missing = missingScopes(verified.scopes, requiredScopes);
    if (missing.length > 0) {
      throw new GrantexTokenError(
        `Grant token is missing required scopes: ${missing.join(', ')}`,
      );
    }
  }

  return verified;
}

/**
 * Decode a grant token (without re-verifying the signature) and map it to
 * a VerifiedGrant shape. Used by GrantsClient.verify() to fill fields the
 * API summary response may omit.
 *
 * @internal
 */
export function mapOnlineVerifyToVerifiedGrant(token: string): VerifiedGrant {
  let payload: GrantTokenPayload;
  try {
    payload = decodeJwt(token) as unknown as GrantTokenPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GrantexTokenError(`Failed to decode grant token: ${message}`);
  }
  return claimsToVerifiedGrant(payload);
}

export function claimsToVerifiedGrant(payload: GrantTokenPayload): VerifiedGrant {
  if (
    typeof payload.jti !== 'string' ||
    typeof payload.sub !== 'string' ||
    typeof payload.agt !== 'string' ||
    typeof payload.dev !== 'string' ||
    !Array.isArray(payload.scp) ||
    payload.scp.some((s) => typeof s !== 'string') ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    throw new GrantexTokenError(
      'Grant token is missing required claims (jti, sub, agt, dev, scp, iat, exp)',
    );
  }

  return {
    tokenId: payload.jti,
    grantId: payload.grnt ?? payload.jti,
    principalId: payload.sub,
    agentDid: payload.agt,
    developerId: payload.dev,
    ...(payload.client_id !== undefined ? { clientId: payload.client_id } : {}),
    scopes: payload.scp,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    ...(payload.parentAgt !== undefined ? { parentAgentDid: payload.parentAgt } : {}),
    ...(payload.parentGrnt !== undefined ? { parentGrantId: payload.parentGrnt } : {}),
    ...(payload.delegationDepth !== undefined ? { delegationDepth: payload.delegationDepth } : {}),
    ...(payload.authorization_details !== undefined
      ? { authorizationDetails: payload.authorization_details }
      : {}),
  };
}

function payloadToVerifiedGrant(payload: GrantTokenPayload): VerifiedGrant {
  return claimsToVerifiedGrant(payload);
}
