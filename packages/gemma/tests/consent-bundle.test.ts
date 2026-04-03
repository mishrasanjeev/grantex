import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createConsentBundle, type ConsentBundle } from '../src/consent/consent-bundle.js';
import { storeBundle, loadBundle } from '../src/consent/bundle-storage.js';
import { refreshBundle, shouldRefresh } from '../src/consent/bundle-refresh.js';
import { BundleTamperedError } from '../src/errors.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeBundleFixture(overrides?: Partial<ConsentBundle>): ConsentBundle {
  return {
    bundleId: 'bnd_01',
    grantToken: 'eyJhbGciOiJSUzI1NiJ9.test.sig',
    jwksSnapshot: {
      keys: [{ kty: 'RSA', kid: 'k1' }],
      fetchedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    },
    offlineAuditKey: {
      publicKey: 'pub-key-pem',
      privateKey: 'priv-key-pem',
      algorithm: 'Ed25519',
    },
    checkpointAt: Date.now(),
    syncEndpoint: 'https://api.grantex.dev/v1/audit/offline-sync',
    offlineExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ConsentBundle', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemma-bundle-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates bundle with all required fields', async () => {
    const mockBundle = makeBundleFixture();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(mockBundle), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    try {
      const bundle = await createConsentBundle({
        apiKey: 'test-key',
        agentId: 'agent_01',
        userId: 'user_01',
        scopes: ['calendar:read'],
      });

      expect(bundle.bundleId).toBe('bnd_01');
      expect(bundle.grantToken).toBeTruthy();
      expect(bundle.jwksSnapshot.keys.length).toBeGreaterThan(0);
      expect(bundle.offlineAuditKey.algorithm).toBe('Ed25519');
      expect(bundle.syncEndpoint).toBeTruthy();
      expect(bundle.offlineExpiresAt).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stores bundle to encrypted file', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'bundle.enc');
    const key = 'super-secret-passphrase-123';

    await storeBundle(bundle, path, key);

    // File should exist and be non-empty binary
    const raw = await readFile(path);
    expect(raw.length).toBeGreaterThan(0);

    // Raw file should NOT contain plaintext bundle fields
    const rawStr = raw.toString('utf-8');
    expect(rawStr).not.toContain('bnd_01');
  });

  it('loads bundle from encrypted file', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'bundle2.enc');
    const key = 'another-secret-key';

    await storeBundle(bundle, path, key);
    const loaded = await loadBundle(path, key);

    expect(loaded.bundleId).toBe(bundle.bundleId);
    expect(loaded.grantToken).toBe(bundle.grantToken);
    expect(loaded.offlineAuditKey.algorithm).toBe('Ed25519');
    expect(loaded.offlineExpiresAt).toBe(bundle.offlineExpiresAt);
  });

  it('detects tampered bundle file', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'bundle3.enc');
    const key = 'correct-key';

    await storeBundle(bundle, path, key);

    // Tamper with the file
    const raw = await readFile(path);
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff);
    await writeFile(path, tampered);

    await expect(loadBundle(path, key)).rejects.toThrow(BundleTamperedError);
  });

  it('refreshes bundle when near expiry', async () => {
    const refreshedBundle = makeBundleFixture({
      offlineExpiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(refreshedBundle), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as typeof fetch;

    try {
      const oldBundle = makeBundleFixture({
        // Expires in 10 minutes — well below 20% threshold
        checkpointAt: Date.now() - 72 * 3600 * 1000,
        offlineExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      });

      expect(shouldRefresh(oldBundle)).toBe(true);

      const newBundle = await refreshBundle(oldBundle, 'test-key');
      expect(newBundle.bundleId).toBe(refreshedBundle.bundleId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
