// SPDX-License-Identifier: Apache-2.0
/**
 * Agent key history rules (PRD §5 Agent, §6, §7 Keys, §8.8).
 *
 * Pure functions only: which rails an agent may declare and the P-256 rule
 * for payments rails, when a key in the history may be used, and the
 * possession proof over a server-issued challenge. The routes in
 * routes/agent-keys.ts own the database side; spec/agent-keys.md is the
 * normative description of the challenge and the proof.
 */
import { createHash, randomBytes } from 'node:crypto';
import { decodeProtectedHeader, errors, importJWK, jwtVerify, type JWK } from 'jose';

/** The rails an agent may declare. */
export const DECLARED_RAILS = ['ap2', 'verifiable_intent', 'acp', 'ucp'] as const;
export type DeclaredRail = (typeof DECLARED_RAILS)[number];

/**
 * Payments rails whose credentials are signed with ES256 on P-256: AP2 and
 * Verifiable Intent. An agent that declares one may hold no other key type.
 */
export const PAYMENTS_RAILS: readonly DeclaredRail[] = ['ap2', 'verifiable_intent'];

export const AGENT_KEY_STATUSES = ['pending', 'active', 'rotated', 'compromised'] as const;
export type AgentKeyStatus = (typeof AGENT_KEY_STATUSES)[number];

/**
 * The JWS `typ` of a possession proof. RFC 8725 §3.11 recommends explicit
 * typing for every new kind of JWT, with the `application/` prefix omitted as
 * RFC 7515 §4.1.9 allows, so a proof can never be mistaken for a DPoP proof
 * (`dpop+jwt`), a grant token or any other JWT the same key signs.
 */
export const KEY_PROOF_TYP = 'agent-key-proof+jwt';

/** How long a challenge can be answered. */
export const CHALLENGE_TTL_SECONDS = 300;
/** Allowed clock difference between the agent and the registry. */
export const PROOF_CLOCK_TOLERANCE_SECONDS = 30;
/** The longest rotation overlap a request may ask for. */
export const MAX_ROTATION_OVERLAP_SECONDS = 30 * 86_400;
/** Keys an agent may hold that are not yet over: pending, active, or rotated within the overlap. */
export const MAX_LIVE_KEYS = 10;

/** Appendix C denial codes for a key that cannot be used. */
export type KeyDenial = 'key_unproven' | 'key_not_active';

export function parseDeclaredRails(value: unknown): DeclaredRail[] {
  if (!Array.isArray(value)) throw new Error('declaredRails must be an array');
  const seen = new Set<string>();
  for (const rail of value) {
    if (typeof rail !== 'string' || !(DECLARED_RAILS as readonly string[]).includes(rail)) {
      throw new Error(`declaredRails entries must be one of: ${DECLARED_RAILS.join(', ')}`);
    }
    if (seen.has(rail)) throw new Error(`declaredRails lists ${rail} more than once`);
    seen.add(rail);
  }
  return value as DeclaredRail[];
}

export function requiresP256(rails: readonly string[]): boolean {
  return rails.some((rail) => (PAYMENTS_RAILS as readonly string[]).includes(rail));
}

/** Why a key with algorithm `alg` may not belong to an agent declaring `rails`, or null if it may. */
export function railAlgorithmError(rails: readonly string[], alg: string): string | null {
  if (!requiresP256(rails) || alg === 'ES256') return null;
  return 'an agent that declares a payments rail (ap2, verifiable_intent) must use ES256 keys on P-256';
}

/**
 * The JWS algorithm of a public JWK that `validateAgentPublicJwk` accepted:
 * RFC 7518 §3.1 names, and EdDSA for Ed25519 (RFC 8037 §3.1).
 */
export function keyAlgorithm(jwk: JWK): string {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return 'EdDSA';
  if (jwk.kty === 'RSA') return 'RS256';
  if (jwk.kty === 'EC') {
    if (jwk.crv === 'P-256') return 'ES256';
    if (jwk.crv === 'P-384') return 'ES384';
    if (jwk.crv === 'P-521') return 'ES512';
  }
  throw new Error('unsupported agent key type');
}

export interface AgentKeyState {
  status: AgentKeyStatus;
  validFrom: Date;
  validTo: Date | null;
  possessionProvedAt: Date | null;
}

export type KeyEvaluation = { usable: true } | { usable: false; denial: KeyDenial };

/**
 * Whether a key in an agent's history may be used at `at`.
 *
 * A pending key, or any key never proven, is `key_unproven`. A compromised
 * key is never usable, whatever its dates. A rotated key is usable strictly
 * before `valid_to` (the end of its overlap) and not at or after it. Unknown
 * statuses fall through to `key_not_active`: the check fails closed.
 */
export function evaluateAgentKey(key: AgentKeyState, at: Date): KeyEvaluation {
  if (key.status === 'compromised') return { usable: false, denial: 'key_not_active' };
  if (key.status === 'pending' || key.possessionProvedAt === null) return { usable: false, denial: 'key_unproven' };
  if (key.status !== 'active' && key.status !== 'rotated') return { usable: false, denial: 'key_not_active' };
  if (at.getTime() < key.validFrom.getTime()) return { usable: false, denial: 'key_not_active' };
  if (key.validTo !== null && at.getTime() >= key.validTo.getTime()) return { usable: false, denial: 'key_not_active' };
  if (key.status === 'rotated' && key.validTo === null) return { usable: false, denial: 'key_not_active' };
  return { usable: true };
}

/** A fresh challenge nonce: 256 bits from the CSPRNG, base64url. */
export function newChallengeNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores for a nonce. */
export function hashChallengeNonce(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

export type KeyProofErrorCode = 'key_unproven' | 'audience_mismatch' | 'key_binding_mismatch';

export class KeyProofError extends Error {
  constructor(readonly code: KeyProofErrorCode, message: string) {
    super(message);
    this.name = 'KeyProofError';
  }
}

export interface RegisteredKey {
  jwk: JWK;
  alg: string;
  thumbprint: string;
}

export interface ProofExpectation {
  /** This registry's audience value: the service's issuer identifier. */
  audience: string;
  /** The agent the key is registered to; the proof's `sub`. */
  agentId: string;
}

const NONCE = /^[A-Za-z0-9_-]{43}$/;
/** Header parameters that point at a key other than the registered one. */
const FOREIGN_KEY_HEADERS = ['jwk', 'jku', 'x5u', 'x5c'] as const;

/**
 * Verify a possession proof: a compact JWS (RFC 7515 §7.1) whose JWT claims
 * (RFC 7519) answer one challenge. Returns the nonce it answers; the caller
 * consumes that nonce atomically, which is what makes the proof single-use.
 *
 * Verified with the registered key only, under its own algorithm only, so
 * neither `alg: none`, an HMAC under the public key, nor a key named in the
 * header can stand in for it. Every failure is a KeyProofError; nothing is
 * swallowed, because an unexplained failure here must still refuse.
 */
export async function verifyKeyPossessionProof(
  proof: unknown,
  key: RegisteredKey,
  expected: ProofExpectation,
): Promise<{ nonce: string; iat: number }> {
  if (typeof proof !== 'string' || proof.length === 0 || proof.length > 16_384) {
    throw new KeyProofError('key_unproven', 'proof must be a compact JWS');
  }
  let header: Record<string, unknown>;
  try {
    header = decodeProtectedHeader(proof) as Record<string, unknown>;
  } catch {
    throw new KeyProofError('key_unproven', 'proof is not a compact JWS');
  }
  for (const name of FOREIGN_KEY_HEADERS) {
    if (name in header) {
      throw new KeyProofError('key_unproven', `proof must not carry a ${name} header; it is verified with the registered key`);
    }
  }
  if (header['kid'] !== undefined && header['kid'] !== key.thumbprint) {
    throw new KeyProofError('key_binding_mismatch', 'proof kid does not name the key being proven');
  }

  let publicKey: Awaited<ReturnType<typeof importJWK>>;
  try {
    publicKey = await importJWK(key.jwk, key.alg);
  } catch {
    // A stored key that cannot be imported proves nothing.
    throw new KeyProofError('key_unproven', 'the registered key cannot verify signatures');
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(proof, publicKey, {
      algorithms: [key.alg],
      typ: KEY_PROOF_TYP,
      audience: expected.audience,
      requiredClaims: ['aud', 'iat', 'nonce', 'sub'],
      maxTokenAge: CHALLENGE_TTL_SECONDS,
      clockTolerance: PROOF_CLOCK_TOLERANCE_SECONDS,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof errors.JWTClaimValidationFailed && err.claim === 'aud') {
      throw new KeyProofError('audience_mismatch', 'proof aud is not this registry');
    }
    if (err instanceof errors.JWSSignatureVerificationFailed) {
      throw new KeyProofError('key_unproven', 'proof signature does not verify with the registered key');
    }
    if (err instanceof errors.JOSEError) {
      throw new KeyProofError('key_unproven', `proof rejected: ${err.message}`);
    }
    throw new KeyProofError('key_unproven', 'proof rejected');
  }

  if (payload['sub'] !== expected.agentId) {
    throw new KeyProofError('key_binding_mismatch', 'proof sub is not the agent the key is registered to');
  }
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) {
    throw new KeyProofError('key_unproven', 'proof nonce is not a challenge this registry issued');
  }
  return { nonce, iat: payload['iat'] as number };
}
