import { afterEach, describe, expect, it, vi } from 'vitest';
import * as jose from 'jose';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOfflineVerifier } from '../src/verifier/offline-verifier.js';
import {
  importKeyByKid,
  isSnapshotExpired,
  type JWKSSnapshot,
} from '../src/verifier/jwks-cache.js';
import { createOfflineAuditLog, verifyEntrySignature } from '../src/audit/offline-audit-log.js';
import { syncAuditLog } from '../src/audit/audit-sync.js';
import { verifyChain } from '../src/audit/hash-chain.js';
import { shouldRefresh } from '../src/consent/bundle-refresh.js';
import type { ConsentBundle } from '../src/consent/consent-bundle.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function rsaFixture(kid = 'regression-key') {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  const snapshot: JWKSSnapshot = {
    keys: [jwk],
    fetchedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  return { privateKey, jwk, snapshot };
}

async function signClaims(
  privateKey: jose.CryptoKey,
  kid: string,
  claims: jose.JWTPayload,
  includeExpiry = true,
): Promise<string> {
  let token = new jose.SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).setIssuedAt();
  if (includeExpiry) token = token.setExpirationTime('1h');
  return token.sign(privateKey);
}

function signingKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    algorithm: 'Ed25519',
  };
}

async function auditFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'gemma-regression-'));
  tempDirs.push(dir);
  return createOfflineAuditLog({ signingKey: signingKey(), logPath: join(dir, 'audit.jsonl') });
}

const auditEntry = {
  action: 'tool:test',
  agentDID: 'did:key:zAgent',
  grantId: 'grant-1',
  scopes: ['read'],
  result: 'success',
};

describe('offline verifier regressions', () => {
  it('rejects expired and malformed JWKS snapshots fail-closed', async () => {
    const expired: JWKSSnapshot = {
      keys: [],
      fetchedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() - 1_000).toISOString(),
    };
    const malformed = { ...expired, validUntil: 'not-a-date' };

    expect(isSnapshotExpired(malformed)).toBe(true);
    await expect(createOfflineVerifier({ jwksSnapshot: expired }).verify('irrelevant'))
      .rejects.toMatchObject({ code: 'JWKS_SNAPSHOT_EXPIRED' });
  });

  it('requires an expiration claim', async () => {
    const { privateKey, snapshot } = await rsaFixture();
    const token = await signClaims(privateKey, 'regression-key', { sub: 'user', scp: [] }, false);

    await expect(createOfflineVerifier({ jwksSnapshot: snapshot }).verify(token))
      .rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
  });

  it('rejects malformed scope and delegation-depth claims', async () => {
    const { privateKey, snapshot } = await rsaFixture();
    const badScopes = await signClaims(privateKey, 'regression-key', { scp: ['read', 42] });
    const badDepth = await signClaims(privateKey, 'regression-key', { delegationDepth: -1 });
    const verifier = createOfflineVerifier({ jwksSnapshot: snapshot });

    await expect(verifier.verify(badScopes)).rejects.toMatchObject({ code: 'INVALID_CLAIM' });
    await expect(verifier.verify(badDepth)).rejects.toMatchObject({ code: 'INVALID_CLAIM' });
  });

  it('does not import a same-kid key that advertises a different algorithm', async () => {
    const { jwk, snapshot } = await rsaFixture();
    const mismatched = { ...jwk, alg: 'RS512' };
    await expect(importKeyByKid({ ...snapshot, keys: [mismatched] }, 'regression-key'))
      .resolves.toBeNull();
  });
});

describe('audit regressions', () => {
  it('serializes concurrent appends into one valid chain', async () => {
    const log = await auditFixture();
    const appended = await Promise.all(
      Array.from({ length: 25 }, (_, index) => log.append({ ...auditEntry, action: `tool:${index}` })),
    );

    expect(new Set(appended.map((entry) => entry.seq)).size).toBe(25);
    expect(verifyChain(await log.entries())).toEqual({ valid: true });
  });

  it('does not rotate away unsynced entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gemma-rotation-'));
    tempDirs.push(dir);
    const log = createOfflineAuditLog({
      signingKey: signingKey(),
      logPath: join(dir, 'audit.jsonl'),
      maxSizeMB: 0.0001,
    });

    await log.append(auditEntry);
    await log.append({ ...auditEntry, action: 'tool:still-local' });

    expect(await log.unsyncedCount()).toBe(2);
    expect(verifyChain(await log.entries())).toEqual({ valid: true });
  });

  it('stops after a failed batch so a later marker cannot discard it', async () => {
    const log = await auditFixture();
    await log.append(auditEntry);
    await log.append({ ...auditEntry, action: 'tool:second' });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls <= 3) throw new Error('offline');
      return new Response(null, { status: 200 });
    }));

    const result = await syncAuditLog(log, {
      endpoint: 'https://api.example.test',
      apiKey: 'key',
      bundleId: 'bundle',
      batchSize: 1,
    });

    expect(calls).toBe(3);
    expect(result.syncedCount).toBe(0);
    expect(await log.unsyncedCount()).toBe(2);
  });

  it('rejects non-progressing batch sizes and invalid signatures safely', async () => {
    const log = await auditFixture();
    await expect(syncAuditLog(log, {
      endpoint: 'https://api.example.test',
      apiKey: 'key',
      bundleId: 'bundle',
      batchSize: 0,
    })).rejects.toThrow('batchSize');

    const entry = await log.append(auditEntry);
    expect(verifyEntrySignature(entry, 'not a public key')).toBe(false);
  });

  it('rejects audit keys that are not declared as Ed25519', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gemma-algorithm-'));
    tempDirs.push(dir);
    expect(() => createOfflineAuditLog({
      signingKey: { ...signingKey(), algorithm: 'RSA' },
      logPath: join(dir, 'audit.jsonl'),
    })).toThrow('Ed25519');
  });
});

describe('bundle refresh regressions', () => {
  it('refreshes fail-closed when bundle timestamps are malformed', () => {
    const bundle = {
      checkpointAt: Number.NaN,
      offlineExpiresAt: 'not-a-date',
    } as ConsentBundle;
    expect(shouldRefresh(bundle)).toBe(true);
  });

  it('refreshes fail-closed when checkpointAt is in the future', () => {
    const bundle = {
      checkpointAt: Date.now() + 60_000,
      offlineExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    } as ConsentBundle;
    expect(shouldRefresh(bundle)).toBe(true);
  });
});
