// SPDX-License-Identifier: Apache-2.0
/**
 * The agent key registry's pure rules: declared rails and the P-256 rule for
 * payments rails, when a key in the history may be used (the rotation overlap
 * boundary), and the possession proof over a server-issued challenge.
 */
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  KEY_PROOF_TYP,
  KeyProofError,
  evaluateAgentKey,
  hashChallengeNonce,
  keyAlgorithm,
  newChallengeNonce,
  parseDeclaredRails,
  railAlgorithmError,
  requiresP256,
  verifyKeyPossessionProof,
  type AgentKeyState,
} from '../src/lib/registry/agent-keys.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';

const AUDIENCE = 'https://grantex.dev';
const AGENT = 'ag_01SHOPPER01';

interface TestKey { privateKey: CryptoKey; jwk: JWK; alg: string; thumbprint: string }

async function key(alg: 'ES256' | 'EdDSA' | 'ES384' | 'RS256'): Promise<TestKey> {
  const { privateKey, publicKey } = alg === 'EdDSA'
    ? await generateKeyPair('EdDSA', { crv: 'Ed25519' })
    : await generateKeyPair(alg);
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, alg, thumbprint: jwkThumbprint(jwk) };
}

async function proof(k: TestKey, overrides: {
  typ?: string; aud?: string; nonce?: string; sub?: string; iat?: number; kid?: string; alg?: string;
  signWith?: TestKey;
} = {}): Promise<string> {
  const signer = overrides.signWith ?? k;
  const payload: Record<string, unknown> = {
    nonce: overrides.nonce ?? randomBytes(32).toString('base64url'),
    sub: overrides.sub ?? AGENT,
  };
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: overrides.alg ?? signer.alg,
      typ: overrides.typ ?? KEY_PROOF_TYP,
      ...(overrides.kid !== undefined ? { kid: overrides.kid } : {}),
    })
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt(overrides.iat ?? Math.floor(Date.now() / 1000))
    .sign(signer.privateKey);
}

const expected = { audience: AUDIENCE, agentId: AGENT };

describe('declared rails and the P-256 rule', () => {
  it('accepts the known rails once each and refuses anything else', () => {
    expect(parseDeclaredRails([])).toEqual([]);
    expect(parseDeclaredRails(['ap2', 'acp'])).toEqual(['ap2', 'acp']);
    for (const bad of [null, 'ap2', ['ap2', 'ap2'], ['AP2'], ['card'], [1]]) {
      expect(() => parseDeclaredRails(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('requires ES256 on P-256 for an agent that declares a payments rail', () => {
    expect(requiresP256(['ap2'])).toBe(true);
    expect(requiresP256(['verifiable_intent', 'ucp'])).toBe(true);
    expect(requiresP256(['acp', 'ucp'])).toBe(false);
    expect(requiresP256([])).toBe(false);
    expect(railAlgorithmError(['ap2'], 'ES256')).toBeNull();
    expect(railAlgorithmError(['ap2'], 'EdDSA')).toMatch(/ES256/);
    expect(railAlgorithmError(['verifiable_intent'], 'ES384')).toMatch(/ES256/);
    expect(railAlgorithmError(['ap2'], 'RS256')).toMatch(/ES256/);
    expect(railAlgorithmError([], 'EdDSA')).toBeNull();
    expect(railAlgorithmError(['acp'], 'EdDSA')).toBeNull();
  });

  it('derives the JWS algorithm from the key', async () => {
    expect(keyAlgorithm((await key('ES256')).jwk)).toBe('ES256');
    expect(keyAlgorithm((await key('ES384')).jwk)).toBe('ES384');
    expect(keyAlgorithm((await key('EdDSA')).jwk)).toBe('EdDSA');
    expect(keyAlgorithm((await key('RS256')).jwk)).toBe('RS256');
  });
});

describe('evaluateAgentKey', () => {
  const t0 = new Date('2026-10-01T00:00:00.000Z');
  const base: AgentKeyState = {
    status: 'active', validFrom: new Date(t0.getTime() - 60_000), validTo: null, possessionProvedAt: t0,
  };

  it('a pending key is unproven and a compromised one is never active', () => {
    expect(evaluateAgentKey({ ...base, status: 'pending', possessionProvedAt: null }, t0))
      .toEqual({ usable: false, denial: 'key_unproven' });
    expect(evaluateAgentKey({ ...base, status: 'compromised', validTo: t0 }, new Date(t0.getTime() - 1)))
      .toEqual({ usable: false, denial: 'key_not_active' });
  });

  it('an active key is usable from valid_from, and unproven without a possession proof', () => {
    expect(evaluateAgentKey(base, t0)).toEqual({ usable: true });
    expect(evaluateAgentKey(base, new Date(base.validFrom.getTime() - 1)))
      .toEqual({ usable: false, denial: 'key_not_active' });
    expect(evaluateAgentKey({ ...base, possessionProvedAt: null }, t0))
      .toEqual({ usable: false, denial: 'key_unproven' });
  });

  it('a rotated key is usable strictly before valid_to and not at or after it', () => {
    const validTo = new Date(t0.getTime() + 7 * 86_400_000);
    const rotated = { ...base, status: 'rotated' as const, validTo };
    expect(evaluateAgentKey(rotated, new Date(validTo.getTime() - 1))).toEqual({ usable: true });
    expect(evaluateAgentKey(rotated, validTo)).toEqual({ usable: false, denial: 'key_not_active' });
    expect(evaluateAgentKey(rotated, new Date(validTo.getTime() + 1))).toEqual({ usable: false, denial: 'key_not_active' });
  });
});

describe('challenge nonces', () => {
  it('are 256-bit base64url values stored only as a SHA-256 hash', () => {
    const nonce = newChallengeNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newChallengeNonce()).not.toBe(nonce);
    expect(hashChallengeNonce(nonce)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashChallengeNonce(nonce)).not.toContain(nonce);
  });
});

describe('verifyKeyPossessionProof', () => {
  it('accepts a proof signed by the registered key and returns its nonce', async () => {
    for (const alg of ['ES256', 'EdDSA', 'RS256'] as const) {
      const k = await key(alg);
      const nonce = randomBytes(32).toString('base64url');
      const result = await verifyKeyPossessionProof(await proof(k, { nonce }), k, expected);
      expect(result.nonce).toBe(nonce);
    }
  });

  it('accepts a kid equal to the thumbprint and refuses any other kid', async () => {
    const k = await key('ES256');
    await expect(verifyKeyPossessionProof(await proof(k, { kid: k.thumbprint }), k, expected)).resolves.toBeTruthy();
    await expect(verifyKeyPossessionProof(await proof(k, { kid: 'other' }), k, expected))
      .rejects.toMatchObject({ code: 'key_binding_mismatch' });
  });

  it('refuses a proof signed by another key', async () => {
    const k = await key('ES256');
    const other = await key('ES256');
    await expect(verifyKeyPossessionProof(await proof(k, { signWith: other }), k, expected))
      .rejects.toMatchObject({ code: 'key_unproven' });
  });

  it('refuses the wrong typ, a missing or wrong audience, the wrong subject and a stale iat', async () => {
    const k = await key('EdDSA');
    await expect(verifyKeyPossessionProof(await proof(k, { typ: 'JWT' }), k, expected))
      .rejects.toMatchObject({ code: 'key_unproven' });
    await expect(verifyKeyPossessionProof(await proof(k, { typ: 'dpop+jwt' }), k, expected))
      .rejects.toMatchObject({ code: 'key_unproven' });
    await expect(verifyKeyPossessionProof(await proof(k, { aud: 'https://provider.example' }), k, expected))
      .rejects.toMatchObject({ code: 'audience_mismatch' });
    await expect(verifyKeyPossessionProof(await proof(k, { sub: 'ag_someone_else' }), k, expected))
      .rejects.toMatchObject({ code: 'key_binding_mismatch' });
    await expect(verifyKeyPossessionProof(await proof(k, { iat: Math.floor(Date.now() / 1000) - 3600 }), k, expected))
      .rejects.toMatchObject({ code: 'key_unproven' });
    await expect(verifyKeyPossessionProof(await proof(k, { iat: Math.floor(Date.now() / 1000) + 3600 }), k, expected))
      .rejects.toMatchObject({ code: 'key_unproven' });
  });

  it('refuses an algorithm other than the key\'s own, unsigned tokens and garbage', async () => {
    const k = await key('ES256');
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: KEY_PROOF_TYP })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ aud: AUDIENCE, nonce: 'n', sub: AGENT, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    for (const bad of [`${header}.${body}.`, 'not-a-jws', '', 'a.b.c']) {
      await expect(verifyKeyPossessionProof(bad, k, expected)).rejects.toBeInstanceOf(KeyProofError);
    }
    const hs = await new SignJWT({ nonce: 'n', sub: AGENT })
      .setProtectedHeader({ alg: 'HS256', typ: KEY_PROOF_TYP })
      .setAudience(AUDIENCE).setIssuedAt()
      .sign(new TextEncoder().encode('0'.repeat(32)));
    await expect(verifyKeyPossessionProof(hs, k, expected)).rejects.toMatchObject({ code: 'key_unproven' });
  });

  it('refuses a proof that names a key in its header, even the right one', async () => {
    const k = await key('ES256');
    const jws = await new SignJWT({ nonce: randomBytes(32).toString('base64url'), sub: AGENT })
      .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP, jwk: k.jwk })
      .setAudience(AUDIENCE).setIssuedAt()
      .sign(k.privateKey);
    await expect(verifyKeyPossessionProof(jws, k, expected)).rejects.toMatchObject({ code: 'key_unproven' });
  });

  it('refuses a proof without a nonce', async () => {
    const k = await key('ES256');
    const jws = await new SignJWT({ sub: AGENT })
      .setProtectedHeader({ alg: 'ES256', typ: KEY_PROOF_TYP })
      .setAudience(AUDIENCE).setIssuedAt()
      .sign(k.privateKey);
    await expect(verifyKeyPossessionProof(jws, k, expected)).rejects.toMatchObject({ code: 'key_unproven' });
  });
});
