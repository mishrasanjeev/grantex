import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { missingScopes } from './scopes.js';
import { GrantexTokenError } from './errors.js';
import type { ActorClaim, VerifiedGrant, VerifyGrantTokenOptions, GrantTokenPayload } from './types.js';

/** Claim holding Grantex's grant record fields (spec/grant-token-0.6.md). */
export const GRANT_CLAIM = 'urn:grantex:grant';

/**
 * Legacy claim aliases and the standard claims that replace them. Reading an
 * alias is deprecated in 0.6 and off by default from 0.7.
 */
export const LEGACY_CLAIM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  agt: `${GRANT_CLAIM}.agent_did`,
  dev: `${GRANT_CLAIM}.developer_id`,
  grnt: `${GRANT_CLAIM}.grant_id`,
  scp: 'scope',
  parentAgt: 'act.sub',
  parentGrnt: `${GRANT_CLAIM}.parent_grant_id`,
  delegationDepth: `${GRANT_CLAIM}.delegation_depth`,
});

const MAX_ACTOR_CHAIN_DEPTH = 10;
const warnedLegacyAliases = new Set<string>();

/** @internal Forget which legacy-alias warnings were emitted. Intended for tests. */
export function clearLegacyClaimWarnings(): void {
  warnedLegacyAliases.clear();
}

function warnLegacyAliases(aliases: readonly string[]): void {
  for (const alias of aliases) {
    if (warnedLegacyAliases.has(alias)) continue;
    warnedLegacyAliases.add(alias);
    const message = `Grant token claim "${alias}" is a legacy alias of ${LEGACY_CLAIM_ALIASES[alias]}. `
      + 'Reading legacy claim aliases is deprecated and stops by default in 0.7; see docs/migration-0.6.md.';
    if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      process.emitWarning(message, { type: 'DeprecationWarning', code: 'GRANTEX_LEGACY_CLAIM' });
    } else if (typeof console !== 'undefined') {
      console.warn(`DeprecationWarning: ${message}`);
    }
  }
}

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

  const legacyClaims = options.legacyClaims ?? true;
  let payload: GrantTokenPayload;
  try {
    const jwtOptions = {
      algorithms,
      issuer: expectedIssuer,
      // Standard-only verification also requires the RFC 9068 token type.
      ...(legacyClaims ? {} : { typ: 'at+jwt' }),
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
  const verified = normalizeGrantClaims(payload as unknown as Record<string, unknown>, legacyClaims);
  checkProofOfPossession(verified, options);
  if (verified.legacyClaimsUsed !== undefined) warnLegacyAliases(verified.legacyClaimsUsed);

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
  return normalizeGrantClaims(payload as unknown as Record<string, unknown>, true);
}

/**
 * Map grant claims to a `VerifiedGrant`: standard claims first, legacy aliases
 * where the standard claim is absent (unless `legacyClaims` is false). Used
 * for `/v1/grants/verify` responses, which carry the aliases by design, so it
 * emits no deprecation warning.
 *
 * @throws {GrantexTokenError} a required claim is missing, a claim is malformed,
 *   or a standard claim and its alias disagree.
 */
export function claimsToVerifiedGrant(
  payload: GrantTokenPayload | Record<string, unknown>,
  options: { legacyClaims?: boolean } = {},
): VerifiedGrant {
  return normalizeGrantClaims(payload as Record<string, unknown>, options.legacyClaims ?? true);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseActor(value: unknown): ActorClaim {
  let current: unknown = value;
  for (let depth = 1; ; depth += 1) {
    if (!isPlainObject(current) || typeof current['sub'] !== 'string' || current['sub'].length === 0) {
      throw new GrantexTokenError('Grant token act claim must be an object with a non-empty string sub');
    }
    if (current['act'] === undefined) break;
    if (depth >= MAX_ACTOR_CHAIN_DEPTH) {
      throw new GrantexTokenError(`Grant token act chain is deeper than ${MAX_ACTOR_CHAIN_DEPTH}`);
    }
    current = current['act'];
  }
  return value as ActorClaim;
}

function stringClaim(record: Record<string, unknown>, name: string, label: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new GrantexTokenError(`Grant token claim ${label} must be a non-empty string`);
  }
  return value;
}

function depthClaim(record: Record<string, unknown>, name: string, label: string): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new GrantexTokenError(`Grant token claim ${label} must be a non-negative integer`);
  }
  return value;
}

function checkProofOfPossession(grant: VerifiedGrant, options: VerifyGrantTokenOptions): void {
  if (options.requireProofOfPossession === true && options.proofJkt === undefined) {
    throw new GrantexTokenError('Proof of possession is required but no proof key thumbprint (proofJkt) was given');
  }
  if (options.proofJkt === undefined) return;
  const jkt = grant.cnf?.jkt;
  if (typeof jkt !== 'string') {
    throw new GrantexTokenError('Grant token is not key-bound (no cnf.jkt) but proof of possession is required');
  }
  const a = new TextEncoder().encode(jkt);
  const b = new TextEncoder().encode(options.proofJkt);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff !== 0) throw new GrantexTokenError('Grant token cnf.jkt does not match the proof key');
}

const NON_NULLABLE_CLAIMS = [GRANT_CLAIM, 'scope', 'scp', 'act', 'cnf', 'client_id', 'aud', 'authorization_details'];

function normalizeGrantClaims(payload: Record<string, unknown>, legacyClaims: boolean): VerifiedGrant {
  // A claim present with a null value is refused, never treated as absent.
  for (const name of NON_NULLABLE_CLAIMS) {
    if (payload[name] === null) throw new GrantexTokenError(`Grant token claim ${name} must not be null`);
  }
  const used: string[] = [];
  const read = <T>(alias: string, standard: T | undefined, legacy: () => T | undefined): T | undefined => {
    if (!legacyClaims) return standard;
    const aliasValue = legacy();
    if (standard !== undefined && aliasValue !== undefined
        && JSON.stringify(standard) !== JSON.stringify(aliasValue)) {
      throw new GrantexTokenError(
        `Grant token claim ${LEGACY_CLAIM_ALIASES[alias]} disagrees with its legacy alias ${alias}`,
      );
    }
    if (standard === undefined && aliasValue !== undefined) used.push(alias);
    return standard ?? aliasValue;
  };

  const rawGrant = payload[GRANT_CLAIM];
  if (rawGrant !== undefined && !isPlainObject(rawGrant)) {
    throw new GrantexTokenError(`Grant token claim ${GRANT_CLAIM} must be an object`);
  }
  const grant = rawGrant ?? {};

  const rawScope = payload['scope'];
  if (rawScope !== undefined && typeof rawScope !== 'string') {
    throw new GrantexTokenError('Grant token claim scope must be a space-delimited string');
  }
  const legacyScopes = (): string[] | undefined => {
    const scp = payload['scp'];
    if (scp === undefined) return undefined;
    if (!Array.isArray(scp) || scp.some((s) => typeof s !== 'string')) {
      throw new GrantexTokenError('Grant token claim scp must be an array of strings');
    }
    return scp as string[];
  };
  let scopes: string[] | undefined;
  if (legacyClaims && rawGrant === undefined && payload['scp'] !== undefined) {
    // A pre-0.6 token: scope, when present, is a lossy join of scp.
    scopes = legacyScopes();
    used.push('scp');
  } else {
    scopes = read('scp', rawScope?.split(' ').filter((s) => s.length > 0), legacyScopes);
  }
  const agentDid = read('agt', stringClaim(grant, 'agent_did', `${GRANT_CLAIM}.agent_did`), () => stringClaim(payload, 'agt', 'agt'));
  const developerId = read('dev', stringClaim(grant, 'developer_id', `${GRANT_CLAIM}.developer_id`), () => stringClaim(payload, 'dev', 'dev'));
  const grantId = read('grnt', stringClaim(grant, 'grant_id', `${GRANT_CLAIM}.grant_id`), () => stringClaim(payload, 'grnt', 'grnt'));
  const parentGrantId = read('parentGrnt', stringClaim(grant, 'parent_grant_id', `${GRANT_CLAIM}.parent_grant_id`), () => stringClaim(payload, 'parentGrnt', 'parentGrnt'));
  const delegationDepth = read('delegationDepth', depthClaim(grant, 'delegation_depth', `${GRANT_CLAIM}.delegation_depth`), () => depthClaim(payload, 'delegationDepth', 'delegationDepth'));
  const act = payload['act'] === undefined ? undefined : parseActor(payload['act']);
  const parentAgentDid = read(
    'parentAgt',
    parentGrantId !== undefined || delegationDepth !== undefined ? act?.sub : undefined,
    () => stringClaim(payload, 'parentAgt', 'parentAgt'),
  );

  const jti = payload['jti'];
  const sub = payload['sub'];
  const iat = payload['iat'];
  const exp = payload['exp'];
  if (
    typeof jti !== 'string' || typeof sub !== 'string' || typeof iat !== 'number' || typeof exp !== 'number'
    || scopes === undefined || agentDid === undefined || developerId === undefined
  ) {
    throw new GrantexTokenError(
      legacyClaims
        ? 'Grant token is missing required claims (jti, sub, iat, exp, scope or scp, agent_did or agt, developer_id or dev)'
        : `Grant token is missing required claims (jti, sub, iat, exp, scope, ${GRANT_CLAIM}.agent_did, ${GRANT_CLAIM}.developer_id)`,
    );
  }
  const clientId = payload['client_id'];
  if (clientId !== undefined && (typeof clientId !== 'string' || clientId.length === 0)) {
    throw new GrantexTokenError('Grant token claim client_id must be a non-empty string');
  }
  const cnf = payload['cnf'];
  if (cnf !== undefined && !isPlainObject(cnf)) {
    throw new GrantexTokenError('Grant token claim cnf must be an object');
  }
  const aud = payload['aud'];
  if (aud !== undefined && typeof aud !== 'string'
      && !(Array.isArray(aud) && aud.every((value) => typeof value === 'string'))) {
    throw new GrantexTokenError('Grant token claim aud must be a string or an array of strings');
  }

  return {
    tokenId: jti,
    grantId: grantId ?? jti,
    principalId: sub,
    agentDid,
    developerId,
    ...(typeof clientId === 'string' ? { clientId } : {}),
    scopes,
    issuedAt: iat,
    expiresAt: exp,
    ...(parentAgentDid !== undefined ? { parentAgentDid } : {}),
    ...(parentGrantId !== undefined ? { parentGrantId } : {}),
    ...(delegationDepth !== undefined ? { delegationDepth } : {}),
    ...(payload['authorization_details'] !== undefined
      ? { authorizationDetails: payload['authorization_details'] }
      : {}),
    ...(act !== undefined ? { act } : {}),
    ...(cnf !== undefined ? { cnf: cnf as { jkt?: string } } : {}),
    ...(typeof aud === 'string' || Array.isArray(aud) ? { audience: aud as string | string[] } : {}),
    ...(used.length > 0 ? { legacyClaimsUsed: used } : {}),
  };
}
