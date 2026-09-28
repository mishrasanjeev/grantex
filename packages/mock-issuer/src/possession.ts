// SPDX-License-Identifier: Apache-2.0
//
// Possession proof: before binding a key into a passport (cnf, RFC 7800
// section 3.2) the issuer makes the agent sign a fresh challenge with that
// key. The challenge and the proof follow the registry's own possession
// proof (spec/agent-keys.md section 4), with the issuer's entity id as the
// audience: a JWS (RFC 7515 section 7.1) of typ agent-key-proof+jwt whose
// claims are aud, sub (the agent DID), nonce and iat. Both sides are here:
// `signPossessionProof` is the agent's, `PossessionVerifier` the issuer's.

import { createHash, randomBytes } from 'node:crypto';
import { jwkThumbprint, type Jwk } from '@grantex/agent-passport';
import {
  ALG_FOR_KIND,
  KEY_HEADER_MEMBERS,
  hasPrivateMembers,
  importPublicKey,
  keyKind,
  parseJws,
  signJws,
  verifySignature,
} from './jose.ts';
import { MockIssuerError } from './errors.ts';

/** spec/agent-keys.md section 4.2: explicit typing (RFC 8725 section 3.11). */
export const POSSESSION_PROOF_TYP = 'agent-key-proof+jwt';
/** A challenge is good for this long (spec/agent-keys.md section 4.1). */
export const POSSESSION_CHALLENGE_TTL_SECONDS = 300;
/** Oldest acceptable proof iat, and the clock tolerance (spec/agent-keys.md section 4.3). */
const PROOF_MAX_AGE_SECONDS = 300;
const PROOF_CLOCK_TOLERANCE_SECONDS = 30;

export interface PossessionChallenge {
  /** RFC 7638 thumbprint of the key to prove. */
  thumbprint: string;
  /** 256-bit base64url nonce. */
  challenge: string;
  /** The issuer's entity id. */
  audience: string;
  /** The agent DID. */
  subject: string;
  typ: typeof POSSESSION_PROOF_TYP;
  alg: 'ES256' | 'EdDSA';
  /** RFC 3339. */
  expiresAt: string;
}

const DID = /^did:[a-z0-9]+:[\s\S]+/;

/** A public P-256 or Ed25519 key, the kinds an Agent Passport can bind. */
export function checkAgentPublicKey(jwk: unknown): Jwk {
  if (typeof jwk !== 'object' || jwk === null || hasPrivateMembers(jwk as Record<string, unknown>)) {
    throw new MockIssuerError('invalid_request', 'the agent key must be a public JWK with no private members');
  }
  if (keyKind(jwk) === null || importPublicKey(jwk as Record<string, unknown>) === null) {
    throw new MockIssuerError('invalid_request', 'the agent key must be a P-256 or Ed25519 public key');
  }
  return jwk as Jwk;
}

export function checkAgentDid(did: unknown): string {
  if (typeof did !== 'string' || !DID.test(did)) throw new MockIssuerError('invalid_request', 'the agent DID is not a DID');
  return did;
}

/** The agent's side: sign the challenge with the private half of the key being proven. */
export function signPossessionProof(params: {
  challenge: PossessionChallenge;
  agentPrivateJwk: Jwk;
  /** Seconds since the epoch; defaults to now. */
  iat?: number;
}): string {
  const { challenge, agentPrivateJwk } = params;
  const kind = keyKind(agentPrivateJwk);
  if (kind === null || typeof agentPrivateJwk.d !== 'string') {
    throw new MockIssuerError('invalid_request', 'the agent key must be a private P-256 or Ed25519 JWK');
  }
  const header = { alg: ALG_FOR_KIND[kind], typ: POSSESSION_PROOF_TYP, kid: challenge.thumbprint };
  const payload = {
    aud: challenge.audience,
    sub: challenge.subject,
    nonce: challenge.challenge,
    iat: params.iat ?? Math.floor(Date.now() / 1000),
  };
  return signJws(header, payload, agentPrivateJwk);
}

interface PendingChallenge {
  thumbprint: string;
  subject: string;
  expiresAt: number;
}

function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('base64url');
}

/**
 * The issuer's side. Challenges live in memory: only their SHA-256 hashes
 * are kept, a new challenge for a key supersedes the earlier ones, and a
 * challenge is used up only by a proof that passes every check, so a
 * failed signature cannot burn it.
 */
export class PossessionVerifier {
  readonly #audience: string;
  readonly #clock: () => number;
  readonly #pending = new Map<string, PendingChallenge>();

  constructor(audience: string, clock: () => number) {
    this.#audience = audience;
    this.#clock = clock;
  }

  challenge(agentDid: string, agentPublicJwk: Jwk): PossessionChallenge {
    checkAgentDid(agentDid);
    const kind = keyKind(checkAgentPublicKey(agentPublicJwk))!;
    const thumbprint = jwkThumbprint(agentPublicJwk);
    for (const [hash, pending] of this.#pending) if (pending.thumbprint === thumbprint) this.#pending.delete(hash);
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = this.#clock() + POSSESSION_CHALLENGE_TTL_SECONDS;
    this.#pending.set(nonceHash(nonce), { thumbprint, subject: agentDid, expiresAt });
    return {
      thumbprint,
      challenge: nonce,
      audience: this.#audience,
      subject: agentDid,
      typ: POSSESSION_PROOF_TYP,
      alg: ALG_FOR_KIND[kind],
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  /**
   * Check a proof for the key about to be bound and use its challenge up.
   * Every failure throws; nothing is issued unless this returns.
   */
  verify(proof: unknown, agentDid: string, agentPublicJwk: Jwk): void {
    const unproven = (message: string) => new MockIssuerError('key_unproven', message);
    if (typeof proof !== 'string' || proof === '') throw unproven('a possession proof is required before issuance');
    const kind = keyKind(checkAgentPublicKey(agentPublicJwk))!;
    const thumbprint = jwkThumbprint(agentPublicJwk);
    const jws = parseJws(proof);
    if (jws === null) throw unproven('the possession proof is not a compact JWS');
    const { header, payload } = jws;
    if (header.typ !== POSSESSION_PROOF_TYP) throw unproven(`the possession proof typ must be ${POSSESSION_PROOF_TYP}`);
    if (KEY_HEADER_MEMBERS.some((m) => Object.hasOwn(header, m)) || Object.hasOwn(header, 'crit')) {
      // The proof is checked with the key being bound only, never a key it names.
      throw unproven('the possession proof header must not name a key or critical extensions');
    }
    const alg = ALG_FOR_KIND[kind];
    if (header.alg !== alg) throw unproven(`the possession proof alg must be ${alg} for this key`);
    if (!verifySignature(alg, agentPublicJwk, jws)) {
      // spec/agent-keys.md section 4.3: the registry refuses this case with key_unproven too.
      throw unproven('the possession proof signature does not verify with the key to be bound');
    }
    if (header.kid !== undefined && header.kid !== thumbprint) {
      throw new MockIssuerError('key_binding_mismatch', 'the possession proof kid is not the key thumbprint');
    }
    if (payload.aud !== this.#audience) {
      throw new MockIssuerError('audience_mismatch', 'the possession proof is for another audience');
    }
    if (payload.sub !== agentDid) {
      throw new MockIssuerError('key_binding_mismatch', 'the possession proof is for another agent');
    }
    const now = this.#clock();
    const { iat, nonce } = payload;
    if (
      typeof iat !== 'number' ||
      !Number.isSafeInteger(iat) ||
      iat > now + PROOF_CLOCK_TOLERANCE_SECONDS ||
      iat < now - PROOF_MAX_AGE_SECONDS - PROOF_CLOCK_TOLERANCE_SECONDS
    ) {
      throw unproven('the possession proof iat is outside the accepted window');
    }
    if (typeof nonce !== 'string') throw unproven('the possession proof has no nonce');
    const hash = nonceHash(nonce);
    const pending = this.#pending.get(hash);
    if (
      pending === undefined ||
      pending.thumbprint !== thumbprint ||
      pending.subject !== agentDid ||
      pending.expiresAt <= now
    ) {
      throw unproven('the challenge is unknown, superseded, already used, expired or for another key');
    }
    this.#pending.delete(hash);
  }
}
