/**
 * OpenID Connect sign-in of approvers (PRD G-3), run by the auth service in
 * the approver's browser: authorization code flow with PKCE (S256), state
 * bound to the browser, and a nonce. The ID token is verified here against an
 * identity provider the service administrator allow-listed for the developer:
 *
 * - discovery `issuer` must equal the configured issuer exactly;
 * - signature by a key from the provider's JWKS selected by `kid`, asymmetric
 *   algorithms only;
 * - `iss`, `aud` containing the client id, `azp` equal to the client id when
 *   present or when there are several audiences, `exp`, `iat`, `nonce`.
 *
 * Nothing here trusts a value a developer API key can set.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { config } from '../../config.js';
import { safeFetch, validateOutboundUrl, type OutboundUrlPolicy } from '../url-security.js';
import { DecisionError, DecisionSubReason } from './policy.js';

export const ID_TOKEN_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

export interface ApproverIdp {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  acrValues: readonly string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

function outboundPolicy(): OutboundUrlPolicy {
  return {
    allowedProtocols: ['https:', 'http:'],
    allowInsecureHttp: config.allowInsecureSsoUrls,
    allowPrivateHosts: config.allowPrivateSsoHosts,
  };
}

function fail(message: string): DecisionError {
  return new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 401, message);
}

const DISCOVERY_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 3_600_000;
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const discoveryCache = new Map<string, { doc: Discovery; fetchedAt: number }>();
const jwksCache = new Map<string, { keys: JSONWebKeySet; fetchedAt: number }>();

/** Clears discovery and key caches (tests). */
export function clearApproverIdpCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<unknown> {
  validateOutboundUrl(url, outboundPolicy());
  let res: Response;
  try {
    res = await safeFetch(url, init, outboundPolicy());
  } catch {
    throw fail('The identity provider could not be reached');
  }
  if (!res.ok) throw fail(`The identity provider answered ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw fail('The identity provider returned invalid JSON');
  }
}

/** OpenID discovery with the issuer check of OpenID Connect Discovery section 4.3. */
export async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.doc;
  const doc = await fetchJson(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`) as Partial<Discovery> | null;
  if (!doc || typeof doc !== 'object') throw fail('Invalid identity provider discovery document');
  if (doc.issuer !== issuer) {
    throw fail('The identity provider discovery issuer does not match the configured issuer');
  }
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const value = doc[key];
    if (typeof value !== 'string') throw fail(`Discovery document has no ${key}`);
    try {
      validateOutboundUrl(value, outboundPolicy());
    } catch {
      throw fail(`Discovery ${key} is not an allowed URL`);
    }
  }
  const valid = doc as Discovery;
  discoveryCache.set(issuer, { doc: valid, fetchedAt: Date.now() });
  return valid;
}

async function keysFor(jwksUri: string, kid: string | undefined): Promise<JSONWebKeySet> {
  const cached = jwksCache.get(jwksUri);
  const now = Date.now();
  const hasKid = (set: JSONWebKeySet) => kid === undefined || set.keys.some((k) => k.kid === kid);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS && (hasKid(cached.keys) || now - cached.fetchedAt < JWKS_REFRESH_COOLDOWN_MS)) {
    return cached.keys;
  }
  const doc = await fetchJson(jwksUri) as JSONWebKeySet | null;
  if (!doc || !Array.isArray(doc.keys)) throw fail('Invalid identity provider JWKS');
  jwksCache.set(jwksUri, { keys: doc, fetchedAt: now });
  return doc;
}

export const base64url = (bytes: Buffer): string => bytes.toString('base64url');
export const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export interface AuthorizationStart {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Builds the authorization request. `maxAgeSeconds` asks the provider to re-authenticate older sessions. */
export async function startAuthorization(idp: ApproverIdp, redirectUri: string, maxAgeSeconds: number): Promise<AuthorizationStart> {
  const discovery = await discover(idp.issuer);
  const state = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(48));
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', idp.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('max_age', String(maxAgeSeconds));
  if (idp.acrValues.length > 0) url.searchParams.set('acr_values', idp.acrValues.join(' '));
  return { url: url.toString(), state, nonce, codeVerifier };
}

/** Exchanges the authorization code and returns the verified ID token payload. */
export async function completeAuthorization(
  idp: ApproverIdp,
  params: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
): Promise<JWTPayload> {
  const discovery = await discover(idp.issuer);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: idp.clientId,
    code_verifier: params.codeVerifier,
    ...(idp.clientSecret !== undefined ? { client_secret: idp.clientSecret } : {}),
  });
  const tokens = await fetchJson(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  }) as Record<string, unknown> | null;
  const idToken = tokens?.['id_token'];
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 16_384) {
    throw fail('The identity provider returned no ID token');
  }
  return verifyIdToken(idp, discovery, idToken, params.nonce);
}

export async function verifyIdToken(idp: ApproverIdp, discovery: Discovery, idToken: string, expectedNonce: string): Promise<JWTPayload> {
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(idToken);
    kid = typeof header.kid === 'string' ? header.kid : undefined;
  } catch {
    throw fail('ID token is not a JWT');
  }
  const keys = await keysFor(discovery.jwks_uri, kid);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
      issuer: idp.issuer,
      audience: idp.clientId,
      algorithms: ID_TOKEN_ALGORITHMS,
      requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'nonce'],
    }));
  } catch {
    throw fail('ID token verification failed');
  }
  const aud = payload.aud;
  const azp = payload['azp'];
  if (Array.isArray(aud) && aud.length > 1 && azp === undefined) throw fail('ID token has several audiences and no azp');
  if (azp !== undefined && azp !== idp.clientId) throw fail('ID token azp is not this client');
  const nonce = payload['nonce'];
  const a = Buffer.from(typeof nonce === 'string' ? nonce : '');
  const b = Buffer.from(expectedNonce);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw fail('ID token nonce does not match the sign-in');
  return payload;
}
