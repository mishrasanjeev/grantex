import * as jose from 'jose';
import { timingSafeEqual } from 'node:crypto';
import type { McpAuthConfig, ClientRegistration } from '../types.js';

export const ALLOWED_ALGORITHMS = ['RS256', 'ES256', 'PS256', 'EdDSA'];

/** Constant-time client secret comparison. */
export function secretMatches(expected: string | undefined, provided: string | undefined): boolean {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
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

/** A client is confidential when it was registered with a secret. */
export function isConfidentialClient(client: ClientRegistration): boolean {
  return typeof client.clientSecret === 'string' && client.clientSecret.length > 0;
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
 * JWKS, `iss` must equal `grantexIssuer`, and `aud` must match the configured
 * audience (defaults to `allowedResources`) when one is set.
 */
export function createGrantexTokenVerifier(config: McpAuthConfig): GrantexTokenVerifier {
  const jwksUrl = resolveJwksUri(config);
  const issuer = config.grantexIssuer;
  const audience = config.audience
    ?? (config.allowedResources && config.allowedResources.length > 0
      ? config.allowedResources
      : undefined);
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
        ...(audience !== undefined ? { audience } : {}),
        ...(currentDate !== undefined ? { currentDate } : {}),
      });
      return payload;
    },
  };
}
