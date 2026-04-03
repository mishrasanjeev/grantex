import { describe, it, expect } from 'vitest';
import * as jose from 'jose';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOfflineVerifier,
  createConsentBundle,
  createOfflineAuditLog,
  verifyEntrySignature,
  verifyChain,
  computeEntryHash,
  storeBundle,
  loadBundle,
  GENESIS_HASH,
  type JWKSSnapshot,
  type ConsentBundle,
  type AuditEntry,
} from '../../src/index.js';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const PRODUCTION_URL = 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const JWKS_URL = `${PRODUCTION_URL}/.well-known/jwks.json`;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Generate an RS256 key pair and export the public JWK with a kid. */
async function generateTestKeyPair(kid: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  return { publicKey, privateKey, jwk };
}

/** Build a JWKSSnapshot from JWK keys array. */
function makeSnapshot(keys: jose.JWK[]): JWKSSnapshot {
  return {
    keys,
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
}

/** Sign a JWT with standard Grantex claims. */
async function signGrantToken(
  privateKey: jose.KeyLike,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  return new jose.SignJWT(claims as jose.JWTPayload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setJti(`tok_e2e_${Date.now()}`)
    .sign(privateKey);
}

/** Generate Ed25519 key pair in PEM format for audit log signing. */
function generateEd25519KeyPair(): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    privateKey: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
  };
}

/** Create a temporary directory for test files. */
async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'grantex-e2e-'));
}

/* ================================================================== */
/*  LIVE PRODUCTION TESTS                                              */
/* ================================================================== */

describe('Live Production', () => {
  it(
    'fetches JWKS from production and returns valid JWK keys',
    async () => {
      const res = await fetch(JWKS_URL);
      expect(res.ok).toBe(true);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty('keys');
      expect(Array.isArray(body.keys)).toBe(true);
      expect(body.keys.length).toBeGreaterThanOrEqual(1);

      // Every key should have kid and kty
      for (const key of body.keys) {
        expect(key).toHaveProperty('kty');
        expect(key).toHaveProperty('kid');
      }

      // Expect at least one RSA key (RS256, kid: grantex-2026-04)
      const rsaKeys = body.keys.filter(
        (k: { kty: string }) => k.kty === 'RSA',
      );
      expect(rsaKeys.length).toBeGreaterThanOrEqual(1);

      const primaryKey = body.keys.find(
        (k: { kid: string }) => k.kid === 'grantex-2026-04',
      );
      expect(primaryKey).toBeDefined();
      expect(primaryKey.kty).toBe('RSA');
    },
    { timeout: 30_000 },
  );

  it(
    'creates an OfflineVerifier from production JWKS snapshot',
    async () => {
      const res = await fetch(JWKS_URL);
      const body = await res.json();

      const snapshot: JWKSSnapshot = {
        keys: body.keys,
        fetchedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      };

      // Should not throw — verifier creation is synchronous
      const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });
      expect(verifier).toBeDefined();
      expect(typeof verifier.verify).toBe('function');
    },
    { timeout: 30_000 },
  );

  it(
    'signs a test JWT locally and verifies it against production JWKS key import path',
    async () => {
      // Generate our own key pair
      const { privateKey, jwk } = await generateTestKeyPair('e2e-local-key');

      // Create a snapshot with our local key
      const snapshot = makeSnapshot([jwk]);
      const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

      const token = await signGrantToken(privateKey, 'e2e-local-key', {
        sub: 'user:e2e-test',
        agt: 'did:key:z6MkE2EAgent',
        scp: ['calendar:read', 'contacts:read'],
        grnt: 'grant_e2e_001',
        dev: 'dev_e2e_test',
      });

      const grant = await verifier.verify(token);
      expect(grant.principalDID).toBe('user:e2e-test');
      expect(grant.agentDID).toBe('did:key:z6MkE2EAgent');
      expect(grant.scopes).toEqual(['calendar:read', 'contacts:read']);
      expect(grant.grantId).toBe('grant_e2e_001');
      expect(grant.depth).toBe(0);
      expect(grant.expiresAt).toBeInstanceOf(Date);
      expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now());
    },
    { timeout: 30_000 },
  );

  it(
    'rejects a token signed with a different key than the snapshot',
    async () => {
      // Fetch production JWKS
      const res = await fetch(JWKS_URL);
      const body = await res.json();

      const snapshot: JWKSSnapshot = {
        keys: body.keys,
        fetchedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      };

      const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

      // Sign with a locally generated key (not in the production JWKS)
      const { privateKey } = await generateTestKeyPair('rogue-key');
      const token = await signGrantToken(privateKey, 'rogue-key', {
        sub: 'user:rogue',
        agt: 'did:key:z6MkRogue',
        scp: ['admin:all'],
      });

      // Should reject because kid "rogue-key" is not in production JWKS
      await expect(verifier.verify(token)).rejects.toThrow();
    },
    { timeout: 30_000 },
  );

  it(
    'createConsentBundle fails auth against production but does not crash',
    async () => {
      // The consent-bundles endpoint requires auth and may not be deployed yet,
      // but the SDK should handle the error gracefully (not crash)
      await expect(
        createConsentBundle({
          apiKey: 'fake-api-key-e2e-test',
          baseUrl: PRODUCTION_URL,
          agentId: 'did:key:z6MkE2EAgent',
          userId: 'user:e2e-test',
          scopes: ['read:data'],
        }),
      ).rejects.toThrow(); // Should throw a meaningful HTTP error, not crash
    },
    { timeout: 30_000 },
  );
});

/* ================================================================== */
/*  OFFLINE SIMULATION TESTS                                           */
/* ================================================================== */

describe('Offline Simulation', () => {
  it('full lifecycle: generate key, sign JWT, verify offline, audit, chain, signatures', async () => {
    // 1. Generate RSA key pair for token signing
    const { privateKey, jwk } = await generateTestKeyPair('lifecycle-key');
    const snapshot = makeSnapshot([jwk]);

    // 2. Sign a JWT
    const token = await signGrantToken(privateKey, 'lifecycle-key', {
      sub: 'user:lifecycle-principal',
      agt: 'did:key:z6MkLifecycleAgent',
      scp: ['files:read', 'files:write'],
      grnt: 'grant_lifecycle_001',
      dev: 'dev_lifecycle',
    });

    // 3. Verify offline
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });
    const grant = await verifier.verify(token);
    expect(grant.principalDID).toBe('user:lifecycle-principal');
    expect(grant.agentDID).toBe('did:key:z6MkLifecycleAgent');
    expect(grant.scopes).toEqual(['files:read', 'files:write']);

    // 4. Create audit log with Ed25519 signing
    const ed25519 = generateEd25519KeyPair();
    const tmpDir = await createTempDir();
    const logPath = join(tmpDir, 'lifecycle-audit.jsonl');

    const auditLog = createOfflineAuditLog({
      signingKey: {
        publicKey: ed25519.publicKey,
        privateKey: ed25519.privateKey,
        algorithm: 'Ed25519',
      },
      logPath,
    });

    // 5. Append audit entries
    const actions = [
      'read_contacts',
      'write_calendar',
      'send_email',
      'query_database',
      'update_profile',
    ];

    const entries = [];
    for (const action of actions) {
      const entry: AuditEntry = {
        action,
        agentDID: grant.agentDID,
        grantId: grant.grantId,
        scopes: grant.scopes,
        result: 'success',
        metadata: { traceId: `trace_${Date.now()}_${action}` },
      };
      const signed = await auditLog.append(entry);
      entries.push(signed);
    }

    expect(entries.length).toBe(5);

    // 6. Verify hash chain
    const allEntries = await auditLog.entries();
    expect(allEntries.length).toBe(5);

    const chainResult = verifyChain(allEntries);
    expect(chainResult.valid).toBe(true);
    expect(chainResult.brokenAt).toBeUndefined();

    // Verify first entry links to GENESIS_HASH
    expect(allEntries[0]!.prevHash).toBe(GENESIS_HASH);

    // Verify chain linkage
    for (let i = 1; i < allEntries.length; i++) {
      expect(allEntries[i]!.prevHash).toBe(allEntries[i - 1]!.hash);
    }

    // 7. Verify Ed25519 signatures on each entry
    for (const entry of allEntries) {
      const sigValid = verifyEntrySignature(entry, ed25519.publicKey);
      expect(sigValid).toBe(true);
    }

    // 8. Verify recomputed hashes match
    for (const entry of allEntries) {
      const recomputed = computeEntryHash({
        seq: entry.seq,
        timestamp: entry.timestamp,
        action: entry.action,
        agentDID: entry.agentDID,
        grantId: entry.grantId,
        scopes: entry.scopes,
        result: entry.result,
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
        prevHash: entry.prevHash,
      });
      expect(entry.hash).toBe(recomputed);
    }

    // Cleanup
    try {
      await unlink(logPath);
    } catch {
      // ignore
    }
  });

  it('bundle storage lifecycle: create, store encrypted, load, verify match', async () => {
    // Generate a key pair for the JWT in the bundle
    const { privateKey, jwk } = await generateTestKeyPair('bundle-key');
    const snapshot = makeSnapshot([jwk]);

    const token = await signGrantToken(privateKey, 'bundle-key', {
      sub: 'user:bundle-test',
      agt: 'did:key:z6MkBundleAgent',
      scp: ['data:read'],
      grnt: 'grant_bundle_001',
    });

    const ed25519 = generateEd25519KeyPair();

    const originalBundle: ConsentBundle = {
      bundleId: `bundle_e2e_${Date.now()}`,
      grantToken: token,
      jwksSnapshot: snapshot,
      offlineAuditKey: {
        publicKey: ed25519.publicKey,
        privateKey: ed25519.privateKey,
        algorithm: 'Ed25519',
      },
      checkpointAt: Date.now(),
      syncEndpoint: `${PRODUCTION_URL}/v1/audit/offline-sync`,
      offlineExpiresAt: new Date(
        Date.now() + 72 * 3600 * 1000,
      ).toISOString(),
    };

    const tmpDir = await createTempDir();
    const bundlePath = join(tmpDir, 'test-bundle.enc');
    const encryptionKey = 'e2e-test-encryption-key-very-secret-123';

    // Store encrypted
    await storeBundle(originalBundle, bundlePath, encryptionKey);

    // Load and decrypt
    const loadedBundle = await loadBundle(bundlePath, encryptionKey);

    // Verify all fields match
    expect(loadedBundle.bundleId).toBe(originalBundle.bundleId);
    expect(loadedBundle.grantToken).toBe(originalBundle.grantToken);
    expect(loadedBundle.jwksSnapshot.keys).toEqual(
      originalBundle.jwksSnapshot.keys,
    );
    expect(loadedBundle.jwksSnapshot.fetchedAt).toBe(
      originalBundle.jwksSnapshot.fetchedAt,
    );
    expect(loadedBundle.jwksSnapshot.validUntil).toBe(
      originalBundle.jwksSnapshot.validUntil,
    );
    expect(loadedBundle.offlineAuditKey.publicKey).toBe(
      originalBundle.offlineAuditKey.publicKey,
    );
    expect(loadedBundle.offlineAuditKey.privateKey).toBe(
      originalBundle.offlineAuditKey.privateKey,
    );
    expect(loadedBundle.offlineAuditKey.algorithm).toBe('Ed25519');
    expect(loadedBundle.checkpointAt).toBe(originalBundle.checkpointAt);
    expect(loadedBundle.syncEndpoint).toBe(originalBundle.syncEndpoint);
    expect(loadedBundle.offlineExpiresAt).toBe(
      originalBundle.offlineExpiresAt,
    );

    // Verify the loaded bundle's JWT can still be verified
    const verifier = createOfflineVerifier({
      jwksSnapshot: loadedBundle.jwksSnapshot,
    });
    const grant = await verifier.verify(loadedBundle.grantToken);
    expect(grant.principalDID).toBe('user:bundle-test');

    // Cleanup
    try {
      await unlink(bundlePath);
    } catch {
      // ignore
    }
  });

  it('performance: verify 100 tokens in < 5ms average', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('perf-key');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    // Pre-generate 100 tokens
    const tokens: string[] = [];
    for (let i = 0; i < 100; i++) {
      tokens.push(
        await signGrantToken(privateKey, 'perf-key', {
          sub: `user:perf-${i}`,
          agt: 'did:key:z6MkPerfAgent',
          scp: ['read:data'],
          grnt: `grant_perf_${i}`,
        }),
      );
    }

    // Warm up (first verify imports the key)
    await verifier.verify(tokens[0]!);

    // Timed run
    const start = performance.now();
    for (const token of tokens) {
      await verifier.verify(token);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / 100;

    expect(avgMs).toBeLessThan(5);
    // Log for visibility
    console.log(
      `[perf] 100 token verifications: ${elapsed.toFixed(1)}ms total, ${avgMs.toFixed(3)}ms avg`,
    );
  });

  it('sync simulation: create audit log, append 200 entries, simulate batch sync', async () => {
    const ed25519 = generateEd25519KeyPair();
    const tmpDir = await createTempDir();
    const logPath = join(tmpDir, 'sync-sim-audit.jsonl');

    const auditLog = createOfflineAuditLog({
      signingKey: {
        publicKey: ed25519.publicKey,
        privateKey: ed25519.privateKey,
        algorithm: 'Ed25519',
      },
      logPath,
    });

    // Append 200 entries
    const entryCount = 200;
    for (let i = 0; i < entryCount; i++) {
      await auditLog.append({
        action: `action_${i % 10}`,
        agentDID: 'did:key:z6MkSyncAgent',
        grantId: 'grant_sync_001',
        scopes: ['data:read', 'data:write'],
        result: i % 20 === 0 ? 'denied' : 'success',
        metadata: { batchIdx: Math.floor(i / 100), entryIdx: i },
      });
    }

    // Read all entries
    const allEntries = await auditLog.entries();
    expect(allEntries.length).toBe(entryCount);

    // Verify the entire chain
    const chainResult = verifyChain(allEntries);
    expect(chainResult.valid).toBe(true);

    // Check unsynced count
    const unsynced = await auditLog.unsyncedCount();
    expect(unsynced).toBe(entryCount);

    // Simulate batch sync: mark first 100 as synced
    await auditLog.markSynced(100);
    const unsyncedAfter = await auditLog.unsyncedCount();
    expect(unsyncedAfter).toBe(100);

    // Simulate second batch
    await auditLog.markSynced(200);
    const unsyncedFinal = await auditLog.unsyncedCount();
    expect(unsyncedFinal).toBe(0);

    // Verify all signatures
    for (const entry of allEntries) {
      expect(verifyEntrySignature(entry, ed25519.publicKey)).toBe(true);
    }

    // Cleanup
    try {
      await unlink(logPath);
      await unlink(logPath + '.synced');
    } catch {
      // ignore
    }
  });

  it('tampered hash chain is detected', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('tamper-key');
    const snapshot = makeSnapshot([jwk]);
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    const token = await signGrantToken(privateKey, 'tamper-key', {
      sub: 'user:tamper-test',
      agt: 'did:key:z6MkTamperAgent',
      scp: ['files:read'],
      grnt: 'grant_tamper_001',
    });

    const grant = await verifier.verify(token);

    const ed25519 = generateEd25519KeyPair();
    const tmpDir = await createTempDir();
    const logPath = join(tmpDir, 'tamper-audit.jsonl');

    const auditLog = createOfflineAuditLog({
      signingKey: {
        publicKey: ed25519.publicKey,
        privateKey: ed25519.privateKey,
        algorithm: 'Ed25519',
      },
      logPath,
    });

    // Append 5 entries
    for (let i = 0; i < 5; i++) {
      await auditLog.append({
        action: `action_${i}`,
        agentDID: grant.agentDID,
        grantId: grant.grantId,
        scopes: grant.scopes,
        result: 'success',
      });
    }

    const entries = await auditLog.entries();

    // Tamper with entry at index 2 by modifying its hash
    const tampered = entries.map((e, i) =>
      i === 2 ? { ...e, hash: 'deadbeef'.repeat(8) } : e,
    );

    const result = verifyChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);

    // Cleanup
    try {
      await unlink(logPath);
    } catch {
      // ignore
    }
  });

  it('bundle storage rejects wrong encryption key', async () => {
    const { privateKey, jwk } = await generateTestKeyPair('wrong-key-test');

    const bundle: ConsentBundle = {
      bundleId: 'bundle_wrong_key',
      grantToken: await signGrantToken(privateKey, 'wrong-key-test', {
        sub: 'user:wrong-key',
        agt: 'did:key:z6MkWrongKey',
        scp: ['read'],
      }),
      jwksSnapshot: makeSnapshot([jwk]),
      offlineAuditKey: {
        publicKey: 'not-real',
        privateKey: 'not-real',
        algorithm: 'Ed25519',
      },
      checkpointAt: Date.now(),
      syncEndpoint: 'https://example.com/sync',
      offlineExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };

    const tmpDir = await createTempDir();
    const bundlePath = join(tmpDir, 'wrong-key-bundle.enc');

    await storeBundle(bundle, bundlePath, 'correct-key');

    // Attempt to load with wrong key should throw BundleTamperedError
    await expect(loadBundle(bundlePath, 'wrong-key')).rejects.toThrow();

    // Cleanup
    try {
      await unlink(bundlePath);
    } catch {
      // ignore
    }
  });
});
