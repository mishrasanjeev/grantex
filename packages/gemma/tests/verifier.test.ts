import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { importKeyByKid, isSnapshotExpired, type JWKSSnapshot } from '../src/verifier/jwks-cache.js';
import { createOfflineVerifier } from '../src/verifier/offline-verifier.js';
import { hasScope, enforceScopes } from '../src/verifier/scope-enforcer.js';
import {
  OfflineVerificationError,
  ScopeViolationError,
  TokenExpiredError,
} from '../src/errors.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function generateTestKeyPair(kid: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  return { publicKey, privateKey, jwk };
}

function makeSnapshot(keys: jose.JWK[], validUntilOffset = 86_400_000): JWKSSnapshot {
  return {
    keys,
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + validUntilOffset).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  jwks-cache tests                                                   */
/* ------------------------------------------------------------------ */

describe('jwks-cache', () => {
  describe('importKeyByKid', () => {
    it('imports a key matching the given kid', async () => {
      const { jwk } = await generateTestKeyPair('target-kid');
      const snapshot = makeSnapshot([jwk]);

      const key = await importKeyByKid(snapshot, 'target-kid');
      expect(key).not.toBeNull();
    });

    it('returns null when kid is not found', async () => {
      const { jwk } = await generateTestKeyPair('existing-kid');
      const snapshot = makeSnapshot([jwk]);

      const key = await importKeyByKid(snapshot, 'nonexistent-kid');
      expect(key).toBeNull();
    });

    it('selects correct key from multiple keys', async () => {
      const k1 = await generateTestKeyPair('kid-A');
      const k2 = await generateTestKeyPair('kid-B');
      const k3 = await generateTestKeyPair('kid-C');
      const snapshot = makeSnapshot([k1.jwk, k2.jwk, k3.jwk]);

      const key = await importKeyByKid(snapshot, 'kid-B');
      expect(key).not.toBeNull();

      // The key should work for verification with k2's private key
      const token = await new jose.SignJWT({ test: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'kid-B' })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(k2.privateKey);

      const result = await jose.jwtVerify(token, key!);
      expect(result.payload.test).toBe(true);
    });

    it('returns null for empty snapshot', async () => {
      const snapshot = makeSnapshot([]);
      const key = await importKeyByKid(snapshot, 'any-kid');
      expect(key).toBeNull();
    });
  });

  describe('isSnapshotExpired', () => {
    it('returns false for valid snapshot', () => {
      const snapshot = makeSnapshot([], 86_400_000); // valid for 24h
      expect(isSnapshotExpired(snapshot)).toBe(false);
    });

    it('returns true for expired snapshot', () => {
      const snapshot = makeSnapshot([], -1000); // expired 1s ago
      expect(isSnapshotExpired(snapshot)).toBe(true);
    });

    it('returns true for snapshot expiring exactly now', () => {
      const snapshot: JWKSSnapshot = {
        keys: [],
        fetchedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() - 1).toISOString(),
      };
      expect(isSnapshotExpired(snapshot)).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  offline-verifier additional tests                                  */
/* ------------------------------------------------------------------ */

describe('offline-verifier (additional)', () => {
  it('falls back to jti when grnt claim is absent', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('fb-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      sub: 'user:alice',
      agt: 'did:key:z6MkA',
      scp: ['read'],
      jti: 'my-jti-value',
      // no grnt claim
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fb-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const grant = await verifier.verify(token);
    expect(grant.grantId).toBe('my-jti-value');
    expect(grant.jti).toBe('my-jti-value');
  });

  it('extracts delegationDepth from token', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('del-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      sub: 'u',
      agt: 'did:key:z6Mk',
      scp: [],
      delegationDepth: 3,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'del-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const grant = await verifier.verify(token);
    expect(grant.depth).toBe(3);
  });

  it('defaults delegationDepth to 0 when absent', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('del-2');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      sub: 'u',
      scp: [],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'del-2' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const grant = await verifier.verify(token);
    expect(grant.depth).toBe(0);
  });

  it('rejects JWT missing kid in header', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('no-kid');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    // Build a JWT without kid in the header
    const token = await new jose.SignJWT({ sub: 'u', scp: [] })
      .setProtectedHeader({ alg: 'RS256' }) // no kid
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    await expect(verifier.verify(token)).rejects.toThrow(OfflineVerificationError);
    await expect(verifier.verify(token)).rejects.toThrow('missing "kid"');
  });

  it('scope violation mode "log" logs instead of throwing', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('log-1');
    const snapshot = makeSnapshot([jwk]);

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      requireScopes: ['admin:write'],
      onScopeViolation: 'log',
    });

    const token = await new jose.SignJWT({
      sub: 'u',
      agt: 'did:key:z6Mk',
      scp: ['read'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'log-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    // Should NOT throw — logs instead
    const grant = await verifier.verify(token);
    expect(grant.scopes).toEqual(['read']);
  });

  it('handles empty scp claim gracefully', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('empty-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      sub: 'u',
      // no scp claim
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'empty-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const grant = await verifier.verify(token);
    expect(grant.scopes).toEqual([]);
  });

  it('handles missing sub claim gracefully', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('nosub-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      scp: ['read'],
      agt: 'did:key:z6Mk',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'nosub-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const grant = await verifier.verify(token);
    expect(grant.principalDID).toBe('');
  });

  it('handles missing agt claim gracefully', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('noagt-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      sub: 'user:test',
      scp: [],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'noagt-1' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    const grant = await verifier.verify(token);
    expect(grant.agentDID).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/*  scope-enforcer additional tests                                    */
/* ------------------------------------------------------------------ */

describe('scope-enforcer (additional)', () => {
  describe('hasScope', () => {
    it('is case-sensitive', () => {
      expect(hasScope(['Calendar:Read'], 'calendar:read')).toBe(false);
    });

    it('does not match partial scope strings', () => {
      expect(hasScope(['calendar:read:all'], 'calendar:read')).toBe(false);
    });
  });

  describe('enforceScopes', () => {
    it('reports all missing scopes in error', () => {
      try {
        enforceScopes(['a'], ['b', 'c', 'd']);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as ScopeViolationError;
        expect(err.requiredScopes).toEqual(['b', 'c', 'd']);
        expect(err.grantScopes).toEqual(['a']);
      }
    });

    it('passes when grant scopes are a superset of required', () => {
      expect(() =>
        enforceScopes(
          ['admin:write', 'calendar:read', 'email:send', 'files:delete'],
          ['calendar:read', 'email:send'],
        ),
      ).not.toThrow();
    });

    it('handles duplicate scopes in grant', () => {
      expect(() =>
        enforceScopes(['read', 'read', 'write'], ['read', 'write']),
      ).not.toThrow();
    });
  });
});
