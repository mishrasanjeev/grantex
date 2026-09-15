import * as jose from 'jose';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { McpAuthConfig, ClientRegistration } from '../types.js';
import { acceptedResources } from './resource.js';

export const ALLOWED_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'EdDSA'];

/** Stored form of a client secret: `sha256:<base64url digest>`. */
export function hashClientSecret(secret: string): string {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('base64url')}`;
}

/**
 * Constant-time check of a presented client secret against the stored hash.
 * False for a missing secret, a missing hash or a hash in an unknown format.
 */
export function secretMatches(expectedHash: string | undefined, provided: string | undefined): boolean {
  if (typeof expectedHash !== 'string' || !expectedHash.startsWith('sha256:')) return false;
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expectedHash);
  const b = Buffer.from(hashClientSecret(provided));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Extracts client credentials from a Basic auth header.
 * Returns [clientId, clientSecret] or undefined if not present.
 */
export function parseBasicAuth(
  authHeader: string | undefined,
): [string, string] | undefined {
  if (!authHeader) return undefined;
  const lower = authHeader.toLowerCase();
  if (!lower.startsWith('basic ')) return undefined;
  const b64 = authHeader.slice(6).trim();
  if (!b64) return undefined;
  const decoded = Buffer.from(b64, 'base64').toString('utf-8');
  const colonIdx = decoded.indexOf(':');
  if (colonIdx < 0) return undefined;
  return [decoded.slice(0, colonIdx), decoded.slice(colonIdx + 1)];
}

/**
 * A client is public only when it registered `token_endpoint_auth_method:
 * none` and holds no secret. Anything else is confidential and must
 * authenticate, so a record that lost its secret hash fails closed.
 */
export function isConfidentialClient(client: ClientRegistration): boolean {
  const hasSecret = typeof client.clientSecretHash === 'string' && client.clientSecretHash.length > 0;
  return hasSecret || client.tokenEndpointAuthMethod !== 'none';
}

export function resolveJwksUri(options: { grantexIssuer?: string; jwksUri?: string }): URL | undefined {
  if (options.jwksUri) return new URL(options.jwksUri);
  if (!options.grantexIssuer) return undefined;
  const base = options.grantexIssuer.endsWith('/')
    ? options.grantexIssuer.slice(0, -1)
    : options.grantexIssuer;
  return new URL(`${base}/.well-known/jwks.json`);
}

export interface GrantexTokenVerifier {
  /** False when `grantexIssuer` is not configured — callers must fail closed. */
  readonly configured: boolean;
  verify(token: string, options?: { ignoreExpiration?: boolean }): Promise<jose.JWTPayload>;
}

/**
 * Builds a verifier for Grantex grant tokens: signature against the Grantex
 * JWKS, `iss` must equal `grantexIssuer`, and `aud` must name the configured
 * `audience` or, by default, one of the resources this server issues tokens
 * for (`resource` and `allowedResources`). The audience is always checked.
 */
export function createGrantexTokenVerifier(config: McpAuthConfig): GrantexTokenVerifier {
  const jwksUrl = resolveJwksUri(config);
  const issuer = config.grantexIssuer;
  const audience = config.audience ?? acceptedResources(config);
  let jwks: ReturnType<typeof jose.createRemoteJWKSet> | undefined;

  return {
    configured: Boolean(jwksUrl && issuer),
    async verify(token, options) {
      if (!jwksUrl || !issuer) {
        throw new Error('grantexIssuer is not configured');
      }
      const header = jose.decodeProtectedHeader(token);
      if (header.alg && !ALLOWED_ALGORITHMS.includes(header.alg)) {
        throw new Error(`Unsupported algorithm: ${header.alg}`);
      }
      if (!jwks) jwks = jose.createRemoteJWKSet(jwksUrl);
      let currentDate: Date | undefined;
      if (options?.ignoreExpiration) {
        // Evaluate the token as of just before its own expiry so an expired
        // (but otherwise valid) token still verifies — used by /revoke.
        const { exp } = jose.decodeJwt(token);
        if (typeof exp === 'number') {
          currentDate = new Date(Math.min(Date.now(), exp * 1000 - 1000));
        }
      }
      const { payload } = await jose.jwtVerify(token, jwks, {
        algorithms: ALLOWED_ALGORITHMS,
        // Tolerate a trailing-slash difference between config and the claim.
        issuer: issuer.endsWith('/') ? [issuer, issuer.slice(0, -1)] : [issuer, `${issuer}/`],
        audience,
        ...(currentDate !== undefined ? { currentDate } : {}),
      });
      return payload;
    },
  };
}
