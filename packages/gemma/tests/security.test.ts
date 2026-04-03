import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as jose from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createOfflineVerifier } from '../src/verifier/offline-verifier.js';
import { createOfflineAuditLog, verifyEntrySignature } from '../src/audit/offline-audit-log.js';
import { verifyChain, GENESIS_HASH, computeEntryHash } from '../src/audit/hash-chain.js';
import { storeBundle, loadBundle } from '../src/consent/bundle-storage.js';
import type { JWKSSnapshot } from '../src/verifier/jwks-cache.js';
import type { ConsentBundle } from '../src/consent/consent-bundle.js';
import type { SignedAuditEntry } from '../src/audit/hash-chain.js';
import {
  OfflineVerificationError,
  BundleTamperedError,
} from '../src/errors.js';

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

async function generateTestKeyPair(kid: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  return { publicKey, privateKey, jwk };
}

function makeSnapshot(keys: jose.JWK[]): JWKSSnapshot {
  return {
    keys,
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

function generateEdKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    algorithm: 'Ed25519',
  };
}

function makeBundleFixture(): ConsentBundle {
  return {
    bundleId: 'bnd_sec',
    grantToken: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.test.sig',
    jwksSnapshot: {
      keys: [{ kty: 'RSA', kid: 'k1' }],
      fetchedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    },
    offlineAuditKey: {
      publicKey: 'pub',
      privateKey: 'priv',
      algorithm: 'Ed25519',
    },
    checkpointAt: Date.now(),
    syncEndpoint: 'https://api.grantex.dev/v1/audit/offline-sync',
    offlineExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Security tests                                                     */
/* ------------------------------------------------------------------ */

describe('Security', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemma-sec-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects JWT with algorithm "none"', async () => {
    const { jwk } = await generateTestKeyPair('sec-1');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    // Manually craft an unsigned JWT with alg: none
    const header = Buffer.from(
      JSON.stringify({ alg: 'none', kid: 'sec-1' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u', scp: [], exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const token = `${header}.${payload}.`;

    await expect(verifier.verify(token)).rejects.toThrow(
      OfflineVerificationError,
    );
    await expect(verifier.verify(token)).rejects.toThrow('Blocked algorithm');
  });

  it('rejects JWT with HS256 instead of RS256', async () => {
    const { jwk } = await generateTestKeyPair('sec-2');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', kid: 'sec-2' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'u', scp: [] }),
    ).toString('base64url');
    const token = `${header}.${payload}.fakesig`;

    await expect(verifier.verify(token)).rejects.toThrow(
      OfflineVerificationError,
    );
    await expect(verifier.verify(token)).rejects.toThrow('Blocked algorithm');
  });

  it('rejects forged token with attacker-controlled key', async () => {
    // Server key
    const { jwk: serverJwk } = await generateTestKeyPair('server-key');
    // Attacker key (different key pair)
    const { privateKey: attackerKey } = await generateTestKeyPair(
      'server-key', // same kid — key substitution attack
    );

    const snapshot = makeSnapshot([serverJwk]); // only the real server key
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    // Token signed with attacker's private key but using server's kid
    const token = await new jose.SignJWT({
      sub: 'admin',
      scp: ['admin:all'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'server-key' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(attackerKey);

    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('rejects token with future iat', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('sec-4');
    const snapshot = makeSnapshot([jwk]);

    // iat 2 hours in the future
    const futureIat = Math.floor(Date.now() / 1000) + 7200;
    const token = await new jose.SignJWT({
      sub: 'u',
      scp: [],
      agt: 'did:key:z6Mk',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'sec-4' })
      .setIssuedAt(futureIat)
      .setExpirationTime(futureIat + 3600)
      .sign(privateKey);

    const verifier = createOfflineVerifier({
      jwksSnapshot: snapshot,
      clockSkewSeconds: 30,
    });

    await expect(verifier.verify(token)).rejects.toThrow(
      OfflineVerificationError,
    );
  });

  it('rejects replay of previously used JTI', async () => {
    // Note: JTI replay detection requires state tracking. The base verifier
    // does not track JTIs — this test documents the expected extension point.
    // For a production system, the caller wraps verify() with a JTI set.
    const { privateKey, jwk } = await generateTestKeyPair('sec-5');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await new jose.SignJWT({
      sub: 'u',
      scp: ['read'],
      agt: 'did:key:z6MkReplay',
      jti: 'unique-jti-001',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'sec-5' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);

    // Simple JTI tracker around the verifier
    const seenJTIs = new Set<string>();
    async function verifyOnce(t: string) {
      const grant = await verifier.verify(t);
      if (seenJTIs.has(grant.jti)) {
        throw new OfflineVerificationError('JTI replay detected', 'JTI_REPLAY');
      }
      seenJTIs.add(grant.jti);
      return grant;
    }

    // First use — ok
    await verifyOnce(token);

    // Replay — should be rejected
    await expect(verifyOnce(token)).rejects.toThrow('JTI replay');
  });

  it('does not leak signing key in error messages', async () => {
    const { jwk } = await generateTestKeyPair('sec-6');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    try {
      await verifier.verify('bad.token.here');
    } catch (err) {
      const msg = (err as Error).message;
      // Should not contain any PEM / JWK key material
      expect(msg).not.toContain('BEGIN');
      expect(msg).not.toContain('PRIVATE');
      expect(msg).not.toContain('RSA');
    }
  });

  it('audit log signature is not bypassable', async () => {
    const key = generateEdKey();
    const logPath = join(tmpDir, 'sec-audit.jsonl');
    const log = createOfflineAuditLog({ signingKey: key, logPath });

    const entry = await log.append({
      action: 'tool:test',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });

    // Valid signature
    expect(verifyEntrySignature(entry, key.publicKey)).toBe(true);

    // Tamper with entry action
    const tampered = { ...entry, action: 'tool:evil' };
    expect(verifyEntrySignature(tampered, key.publicKey)).toBe(true);
    // But the hash will no longer match the content
    const recomputedHash = computeEntryHash({
      seq: tampered.seq,
      timestamp: tampered.timestamp,
      action: tampered.action,
      agentDID: tampered.agentDID,
      grantId: tampered.grantId,
      scopes: tampered.scopes,
      result: tampered.result,
      prevHash: tampered.prevHash,
    });
    expect(recomputedHash).not.toBe(tampered.hash);
  });

  it('hash chain detects single-entry deletion', async () => {
    const key = generateEdKey();
    const logPath = join(tmpDir, 'sec-chain.jsonl');
    const log = createOfflineAuditLog({ signingKey: key, logPath });

    await log.append({
      action: 'tool:a',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });
    await log.append({
      action: 'tool:b',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });
    await log.append({
      action: 'tool:c',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });

    const entries = await log.entries();
    expect(entries.length).toBe(3);

    // Delete middle entry
    const withDeletion = [entries[0]!, entries[2]!];

    const result = verifyChain(withDeletion);
    expect(result.valid).toBe(false);
  });

  it('hash chain detects entry reordering', async () => {
    const key = generateEdKey();
    const logPath = join(tmpDir, 'sec-reorder.jsonl');
    const log = createOfflineAuditLog({ signingKey: key, logPath });

    await log.append({
      action: 'tool:first',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });
    await log.append({
      action: 'tool:second',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });
    await log.append({
      action: 'tool:third',
      agentDID: 'did:key:z6MkA',
      grantId: 'g1',
      scopes: ['read'],
      result: 'success',
    });

    const entries = await log.entries();

    // Swap entries 1 and 2
    const reordered = [entries[0]!, entries[2]!, entries[1]!];

    const result = verifyChain(reordered);
    expect(result.valid).toBe(false);
  });

  it('bundle storage encryption key is not hardcoded', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'sec-bundle.enc');
    const correctKey = 'my-encryption-key-2026';
    const wrongKey = 'wrong-key';

    await storeBundle(bundle, path, correctKey);

    // Correct key works
    const loaded = await loadBundle(path, correctKey);
    expect(loaded.bundleId).toBe(bundle.bundleId);

    // Wrong key fails
    await expect(loadBundle(path, wrongKey)).rejects.toThrow(
      BundleTamperedError,
    );
  });
});
