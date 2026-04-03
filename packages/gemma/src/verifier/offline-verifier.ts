import * as jose from 'jose';
import type { JWKSSnapshot } from './jwks-cache.js';
import { importKeyByKid } from './jwks-cache.js';
import { enforceScopes } from './scope-enforcer.js';
import {
  OfflineVerificationError,
  TokenExpiredError,
} from '../errors.js';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface OfflineVerifierOptions {
  /** Pre-fetched JWKS keys for offline signature verification. */
  jwksSnapshot: JWKSSnapshot;
  /** Allowed clock-skew tolerance in seconds (default 30). */
  clockSkewSeconds?: number;
  /** Scopes that must be present in every verified token. */
  requireScopes?: string[];
  /** Maximum delegation depth allowed (inclusive). */
  maxDelegationDepth?: number;
  /** Behaviour when a scope check fails: `'throw'` (default) or `'log'`. */
  onScopeViolation?: 'throw' | 'log';
}

export interface VerifiedGrant {
  agentDID: string;
  principalDID: string;
  scopes: string[];
  expiresAt: Date;
  jti: string;
  grantId: string;
  depth: number;
}

export interface OfflineVerifier {
  verify(token: string): Promise<VerifiedGrant>;
}

/* ------------------------------------------------------------------ */
/*  Blocked algorithms                                                 */
/* ------------------------------------------------------------------ */

const BLOCKED_ALGORITHMS = new Set(['none', 'HS256']);

/* ------------------------------------------------------------------ */
/*  Factory                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create an offline JWT verifier that validates Grantex grant tokens
 * entirely on-device using a pre-fetched JWKS snapshot.
 *
 * No network call is made during verification.
 */
export function createOfflineVerifier(
  options: OfflineVerifierOptions,
): OfflineVerifier {
  const {
    jwksSnapshot,
    clockSkewSeconds = 30,
    requireScopes,
    maxDelegationDepth,
    onScopeViolation = 'throw',
  } = options;

  return {
    async verify(token: string): Promise<VerifiedGrant> {
      /* ---- Decode header (unverified) to get kid + alg ---------- */
      let header: jose.ProtectedHeaderParameters;
      try {
        header = jose.decodeProtectedHeader(token);
      } catch {
        throw new OfflineVerificationError(
          'Malformed JWT: unable to decode header',
          'MALFORMED_TOKEN',
        );
      }

      const alg = header.alg ?? '';
      if (BLOCKED_ALGORITHMS.has(alg)) {
        throw new OfflineVerificationError(
          `Blocked algorithm: ${alg}`,
          'BLOCKED_ALGORITHM',
        );
      }

      const kid = header.kid;
      if (!kid) {
        throw new OfflineVerificationError(
          'JWT header missing "kid" claim',
          'MISSING_KID',
        );
      }

      /* ---- Resolve signing key from snapshot -------------------- */
      const key = await importKeyByKid(jwksSnapshot, kid);
      if (!key) {
        throw new OfflineVerificationError(
          `No key found in JWKS snapshot for kid="${kid}"`,
          'KID_NOT_FOUND',
        );
      }

      /* ---- Verify signature + standard claims ------------------- */
      let payload: jose.JWTPayload;
      try {
        const result = await jose.jwtVerify(token, key, {
          algorithms: ['RS256'],
          clockTolerance: clockSkewSeconds,
        });
        payload = result.payload;
      } catch (err) {
        if (err instanceof jose.errors.JWTExpired) {
          const exp = (err as jose.errors.JWTExpired).payload?.exp;
          throw new TokenExpiredError(
            new Date((exp ?? 0) * 1000),
          );
        }
        throw new OfflineVerificationError(
          `JWT verification failed: ${(err as Error).message}`,
          'VERIFICATION_FAILED',
        );
      }

      /* ---- Check iat is not in the future ----------------------- */
      if (typeof payload.iat === 'number') {
        const iatMs = payload.iat * 1000;
        const nowMs = Date.now() + clockSkewSeconds * 1000;
        if (iatMs > nowMs) {
          throw new OfflineVerificationError(
            'Token iat is in the future',
            'FUTURE_IAT',
          );
        }
      }

      /* ---- Extract Grantex-specific claims ---------------------- */
      const scopes = Array.isArray(payload['scp'])
        ? (payload['scp'] as string[])
        : [];
      const agentDID = (payload['agt'] as string) ?? '';
      const principalDID = (payload['sub'] as string) ?? '';
      const jti = (payload['jti'] as string) ?? '';
      const grantId = (payload['grnt'] as string) ?? jti;
      const depth =
        typeof payload['delegationDepth'] === 'number'
          ? (payload['delegationDepth'] as number)
          : 0;
      const exp = payload['exp'] as number | undefined;
      const expiresAt = new Date((exp ?? 0) * 1000);

      /* ---- Scope enforcement ------------------------------------ */
      if (requireScopes && requireScopes.length > 0) {
        if (onScopeViolation === 'throw') {
          enforceScopes(scopes, requireScopes);
        } else {
          const missing = requireScopes.filter((s) => !scopes.includes(s));
          if (missing.length > 0) {
            // eslint-disable-next-line no-console
            console.warn(
              `[grantex/gemma] Scope violation: required [${requireScopes.join(', ')}] but grant has [${scopes.join(', ')}]`,
            );
          }
        }
      }

      /* ---- Delegation depth enforcement ------------------------- */
      if (maxDelegationDepth !== undefined && depth > maxDelegationDepth) {
        throw new OfflineVerificationError(
          `Delegation depth ${depth} exceeds maximum ${maxDelegationDepth}`,
          'DELEGATION_DEPTH_EXCEEDED',
        );
      }

      return {
        agentDID,
        principalDID,
        scopes,
        expiresAt,
        jti,
        grantId,
        depth,
      };
    },
  };
}
