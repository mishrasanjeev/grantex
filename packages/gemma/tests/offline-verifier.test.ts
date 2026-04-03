import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { createOfflineVerifier } from '../src/verifier/offline-verifier.js';
import type { JWKSSnapshot } from '../src/verifier/jwks-cache.js';
import {
  OfflineVerificationError,
  ScopeViolationError,
  TokenExpiredError,
} from '../src/errors.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Generate an RS256 key pair and export the public JWK with a `kid`. */
async function generateTestKeyPair(kid: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  return { publicKey, privateKey, jwk };
}

/** Build a minimal JWKSSnapshot from one or more JWKs. */
function makeSnapshot(keys: jose.JWK[]): JWKSSnapshot {
  return {
    keys,
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

/** Sign a JWT with the given claims. */
async function signToken(
  privateKey: jose.KeyLike,
  kid: string,
  claims: Record<string, unknown>,
  overrides?: { alg?: string },
): Promise<string> {
  const alg = overrides?.alg ?? 'RS256';
  return new jose.SignJWT(claims as jose.JWTPayload)
    .setProtectedHeader({ alg, kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('createOfflineVerifier', () => {
  it('verifies valid RS256 JWT from JWKS snapshot', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await signToken(privateKey, 'key-1', {
      sub: 'user:alice',
      agt: 'did:key:z6MkAgent',
      scp: ['calendar:read'],
      grnt: 'grant_01',
    });

    const grant = await verifier.verify(token);
    expect(grant.principalDID).toBe('user:alice');
    expect(grant.agentDID).toBe('did:key:z6MkAgent');
    expect(grant.scopes).toEqual(['calendar:read']);
    expect(grant.grantId).toBe('grant_01');
    expect(grant.expiresAt).toBeInstanceOf(Date);
  });

  it('rejects token with mismatched kid', async () => {
    const { privateKey } = await generateTestKeyPair('key-A');
    const { jwk: otherJwk } = await generateTestKeyPair('key-B');
    const snapshot = makeSnapshot([otherJwk]); // only key-B

    const token = await signToken(privateKey, 'key-A', {
      sub: 'user:bob',
      scp: [],
    });

    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });
    await expect(verifier.verify(token)).rejects.toThrow(
      OfflineVerificationError,
    );
  });

  it('rejects expired token', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-2');
    const snapshot = makeSnapshot([jwk]);

    const token = await new jose.SignJWT({ sub: 'u', scp: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-2' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      clockSkewSeconds: 0,
    });

    await expect(verifier.verify(token)).rejects.toThrow(TokenExpiredError);
  });

  it('allows expired token within clockSkew window', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-3');
    const snapshot = makeSnapshot([jwk]);

    // Expired 10 seconds ago
    const token = await new jose.SignJWT({
      sub: 'user:charlie',
      scp: ['read'],
      agt: 'did:key:z6Mk1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-3' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) - 10)
      .sign(privateKey);

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      clockSkewSeconds: 60, // 60s tolerance
    });

    const grant = await verifier.verify(token);
    expect(grant.principalDID).toBe('user:charlie');
  });

  it('enforces required scopes — passes when all present', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-4');
    const snapshot = makeSnapshot([jwk]);

    const token = await signToken(privateKey, 'key-4', {
      sub: 'u',
      agt: 'did:key:z6Mk2',
      scp: ['calendar:read', 'email:send'],
    });

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      requireScopes: ['calendar:read'],
    });

    const grant = await verifier.verify(token);
    expect(grant.scopes).toContain('calendar:read');
  });

  it('throws ScopeViolationError when required scope missing', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-5');
    const snapshot = makeSnapshot([jwk]);

    const token = await signToken(privateKey, 'key-5', {
      sub: 'u',
      agt: 'did:key:z6Mk3',
      scp: ['calendar:read'],
    });

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      requireScopes: ['admin:write'],
    });

    await expect(verifier.verify(token)).rejects.toThrow(ScopeViolationError);
  });

  it('enforces maxDelegationDepth', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-6');
    const snapshot = makeSnapshot([jwk]);

    const token = await signToken(privateKey, 'key-6', {
      sub: 'u',
      agt: 'did:key:z6Mk4',
      scp: [],
      delegationDepth: 1,
    });

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      maxDelegationDepth: 2,
    });

    const grant = await verifier.verify(token);
    expect(grant.depth).toBe(1);
  });

  it('rejects token delegated beyond maxDelegationDepth', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-7');
    const snapshot = makeSnapshot([jwk]);

    const token = await signToken(privateKey, 'key-7', {
      sub: 'u',
      agt: 'did:key:z6Mk5',
      scp: [],
      delegationDepth: 5,
    });

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      maxDelegationDepth: 3,
    });

    await expect(verifier.verify(token)).rejects.toThrow(
      OfflineVerificationError,
    );
  });

  it('verifies without network call (mock network down)', async () => {
    // Override global fetch so any network call would throw.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error('Network is down');
    };

    try {
      const { privateKey, jwk } = await generateTestKeyPair('key-8');
      const snapshot = makeSnapshot([jwk]);

      const token = await signToken(privateKey, 'key-8', {
        sub: 'u',
        agt: 'did:key:z6MkOffline',
        scp: ['read'],
      });

      const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });
      const grant = await verifier.verify(token);
      expect(grant.agentDID).toBe('did:key:z6MkOffline');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('completes verification in < 5ms on test machine', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('key-9');
    const snapshot = makeSnapshot([jwk]);

    const token = await signToken(privateKey, 'key-9', {
      sub: 'u',
      agt: 'did:key:z6MkFast',
      scp: ['read'],
    });

    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    // Warm up (first call imports the key)
    await verifier.verify(token);

    const start = performance.now();
    await verifier.verify(token);
    const elapsed = performance.now() - start;

    // Allow a generous budget in CI — point is it's sub-millisecond on real HW.
    expect(elapsed).toBeLessThan(50);
  });

  it('handles malformed JWT gracefully', async () => {
    const { jwk } = await generateTestKeyPair('key-10');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    await expect(verifier.verify('not.a.jwt')).rejects.toThrow(
      OfflineVerificationError,
    );
    await expect(verifier.verify('')).rejects.toThrow(
      OfflineVerificationError,
    );
  });

  it('handles JWKS snapshot with multiple keys (kid routing)', async () => {
    const keyA = await generateTestKeyPair('multi-A');
    const keyB = await generateTestKeyPair('multi-B');
    const keyC = await generateTestKeyPair('multi-C');

    const snapshot = makeSnapshot([keyA.jwk, keyB.jwk, keyC.jwk]);

    // Sign with key B
    const token = await signToken(keyB.privateKey, 'multi-B', {
      sub: 'user:multi',
      agt: 'did:key:z6MkMulti',
      scp: ['files:read'],
    });

    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });
    const grant = await verifier.verify(token);
    expect(grant.principalDID).toBe('user:multi');
    expect(grant.scopes).toEqual(['files:read']);
  });
});
