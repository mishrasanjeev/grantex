import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { GrantexTokenError } from './errors.js';
import type { VerifiedGrant, VerifyGrantTokenOptions, GrantTokenPayload } from './types.js';

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
 * Algorithm is fixed to RS256 per SPEC §11 and cannot be overridden.
 *
 * @throws {GrantexTokenError} if the token is invalid, expired, or missing required scopes.
 */
export async function verifyGrantToken(
  token: string,
  options: VerifyGrantTokenOptions,
): Promise<VerifiedGrant> {
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
      algorithms: ['RS256'] as string[],
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

  const requiredScopes = options.requiredScopes ?? [];
  if (requiredScopes.length > 0) {
    const missing = requiredScopes.filter((s) => !payload.scp.includes(s));
    if (missing.length > 0) {
      throw new GrantexTokenError(
        `Grant token is missing required scopes: ${missing.join(', ')}`,
      );
    }
  }

  return payloadToVerifiedGrant(payload);
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
    scopes: payload.scp,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    ...(payload.parentAgt !== undefined ? { parentAgentDid: payload.parentAgt } : {}),
      ...(payload.parentGrnt !== undefined ? { parentGrantId: payload.parentGrnt } : {}),
      ...(payload.delegationDepth !== undefined ? { delegationDepth: payload.delegationDepth } : {}),
  };
}

function payloadToVerifiedGrant(payload: GrantTokenPayload): VerifiedGrant {
  return claimsToVerifiedGrant(payload);
}
