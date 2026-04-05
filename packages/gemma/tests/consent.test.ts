import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConsentBundle,
  type ConsentBundle,
  type CreateConsentBundleOptions,
} from '../src/consent/consent-bundle.js';
import { storeBundle, loadBundle } from '../src/consent/bundle-storage.js';
import { shouldRefresh, refreshBundle } from '../src/consent/bundle-refresh.js';
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
/*  bundle-refresh tests                                               */
/* ------------------------------------------------------------------ */

describe('bundle-refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('shouldRefresh', () => {
    it('returns true when less than 20% TTL remaining', () => {
      const totalTTL = 72 * 3600 * 1000; // 72h
      const bundle = makeBundleFixture({
        checkpointAt: Date.now() - totalTTL,
        offlineExpiresAt: new Date(Date.now() + totalTTL * 0.1).toISOString(), // 10% remaining
      });

      expect(shouldRefresh(bundle)).toBe(true);
    });

    it('returns false when more than 20% TTL remaining', () => {
      const totalTTL = 72 * 3600 * 1000;
      const bundle = makeBundleFixture({
        checkpointAt: Date.now() - totalTTL * 0.5,
        offlineExpiresAt: new Date(Date.now() + totalTTL * 0.5).toISOString(), // 50% remaining
      });

      expect(shouldRefresh(bundle)).toBe(false);
    });

    it('returns true when bundle is already expired', () => {
      const bundle = makeBundleFixture({
        checkpointAt: Date.now() - 100_000,
        offlineExpiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
      });

      expect(shouldRefresh(bundle)).toBe(true);
    });

    it('returns true when totalTTL is zero or negative', () => {
      const bundle = makeBundleFixture({
        checkpointAt: Date.now(),
        offlineExpiresAt: new Date(Date.now() - 1).toISOString(),
      });

      expect(shouldRefresh(bundle)).toBe(true);
    });

    it('returns false at exactly 20% boundary', () => {
      // At exactly 20%, remaining/total = 0.2, so < 0.2 is false
      const totalTTL = 100_000;
      const now = Date.now();
      const bundle = makeBundleFixture({
        checkpointAt: now - totalTTL * 0.8,
        offlineExpiresAt: new Date(now + totalTTL * 0.2 + 1).toISOString(), // just above 20%
      });

      expect(shouldRefresh(bundle)).toBe(false);
    });
  });

  describe('refreshBundle', () => {
    it('calls correct endpoint with POST and Bearer auth', async () => {
      const oldBundle = makeBundleFixture();
      const newBundle = makeBundleFixture({ bundleId: 'bnd_refreshed' });

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () =>
        new Response(JSON.stringify(newBundle), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      globalThis.fetch = fetchSpy as typeof fetch;

      try {
        const result = await refreshBundle(oldBundle, 'test-api-key');

        expect(result.bundleId).toBe('bnd_refreshed');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('https://api.grantex.dev/v1/consent-bundles/bnd_01/refresh');
        expect((init as RequestInit).method).toBe('POST');
        expect((init as RequestInit).headers).toEqual(
          expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('uses custom baseUrl when provided', async () => {
      const bundle = makeBundleFixture();
      const newBundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      let calledUrl = '';
      globalThis.fetch = vi.fn(async (url) => {
        calledUrl = url as string;
        return new Response(JSON.stringify(newBundle), { status: 200 });
      }) as typeof fetch;

      try {
        await refreshBundle(bundle, 'key', 'https://custom.api.dev');
        expect(calledUrl).toBe('https://custom.api.dev/v1/consent-bundles/bnd_01/refresh');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('strips trailing slash from baseUrl', async () => {
      const bundle = makeBundleFixture();
      const newBundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      let calledUrl = '';
      globalThis.fetch = vi.fn(async (url) => {
        calledUrl = url as string;
        return new Response(JSON.stringify(newBundle), { status: 200 });
      }) as typeof fetch;

      try {
        await refreshBundle(bundle, 'key', 'https://api.grantex.dev/');
        expect(calledUrl).toBe('https://api.grantex.dev/v1/consent-bundles/bnd_01/refresh');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws on HTTP error response', async () => {
      const bundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response('Server Error', { status: 500 }),
      ) as typeof fetch;

      try {
        await expect(refreshBundle(bundle, 'key')).rejects.toThrow(
          'Failed to refresh consent bundle: HTTP 500',
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

/* ------------------------------------------------------------------ */
/*  bundle-storage tests                                               */
/* ------------------------------------------------------------------ */

describe('bundle-storage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'gemma-storage-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a bundle through encrypt/decrypt', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'bundle.enc');
    const key = 'test-passphrase';

    await storeBundle(bundle, path, key);
    const loaded = await loadBundle(path, key);

    expect(loaded.bundleId).toBe(bundle.bundleId);
    expect(loaded.grantToken).toBe(bundle.grantToken);
    expect(loaded.jwksSnapshot.keys).toEqual(bundle.jwksSnapshot.keys);
    expect(loaded.offlineAuditKey.algorithm).toBe('Ed25519');
  });

  it('encrypted file does not contain plaintext fields', async () => {
    const bundle = makeBundleFixture({
      bundleId: 'super_secret_id',
      grantToken: 'jwt_highly_sensitive',
    });
    const path = join(tmpDir, 'bundle-plain.enc');

    await storeBundle(bundle, path, 'key');
    const raw = await readFile(path, 'utf-8');

    expect(raw).not.toContain('super_secret_id');
    expect(raw).not.toContain('jwt_highly_sensitive');
  });

  it('fails to decrypt with wrong key', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'wrong-key.enc');

    await storeBundle(bundle, path, 'correct-key');
    await expect(loadBundle(path, 'wrong-key')).rejects.toThrow(BundleTamperedError);
  });

  it('throws BundleTamperedError for truncated file', async () => {
    const path = join(tmpDir, 'truncated.enc');
    // Write a file shorter than IV_BYTES + TAG_BYTES (12 + 16 = 28)
    await writeFile(path, Buffer.alloc(10));

    await expect(loadBundle(path, 'key')).rejects.toThrow(BundleTamperedError);
    await expect(loadBundle(path, 'key')).rejects.toThrow('Bundle file too short');
  });

  it('throws BundleTamperedError when ciphertext is corrupted', async () => {
    const bundle = makeBundleFixture();
    const path = join(tmpDir, 'corrupted.enc');

    await storeBundle(bundle, path, 'key');

    // Corrupt the ciphertext portion (after IV + tag)
    const raw = await readFile(path);
    const corrupted = Buffer.from(raw);
    for (let i = 28; i < corrupted.length; i++) {
      corrupted[i] = (corrupted[i]! ^ 0xff);
    }
    await writeFile(path, corrupted);

    await expect(loadBundle(path, 'key')).rejects.toThrow(BundleTamperedError);
  });

  it('handles bundles with complex nested data', async () => {
    const bundle = makeBundleFixture({
      jwksSnapshot: {
        keys: [
          { kty: 'RSA', kid: 'k1', n: 'long-modulus-value', e: 'AQAB' },
          { kty: 'RSA', kid: 'k2', n: 'another-modulus', e: 'AQAB' },
        ],
        fetchedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    const path = join(tmpDir, 'complex.enc');

    await storeBundle(bundle, path, 'pass');
    const loaded = await loadBundle(path, 'pass');
    expect(loaded.jwksSnapshot.keys).toHaveLength(2);
    expect(loaded.jwksSnapshot.keys[1]!.kid).toBe('k2');
  });

  it('uses different IV for each encryption', async () => {
    const bundle = makeBundleFixture();
    const path1 = join(tmpDir, 'iv1.enc');
    const path2 = join(tmpDir, 'iv2.enc');

    await storeBundle(bundle, path1, 'key');
    await storeBundle(bundle, path2, 'key');

    const raw1 = await readFile(path1);
    const raw2 = await readFile(path2);

    // IVs (first 12 bytes) should differ
    const iv1 = raw1.subarray(0, 12);
    const iv2 = raw2.subarray(0, 12);
    expect(Buffer.compare(iv1, iv2)).not.toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/*  consent-bundle tests                                               */
/* ------------------------------------------------------------------ */

describe('consent-bundle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createConsentBundle', () => {
    it('sends correct request body to the API', async () => {
      const mockBundle = makeBundleFixture();
      let capturedBody: Record<string, unknown> | null = null;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (_url, init) => {
        capturedBody = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(mockBundle), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch;

      try {
        await createConsentBundle({
          apiKey: 'dev-key',
          agentId: 'agent_01',
          userId: 'user_01',
          scopes: ['calendar:read', 'email:send'],
          offlineTTL: '48h',
        });

        expect(capturedBody).not.toBeNull();
        expect(capturedBody!.agentId).toBe('agent_01');
        expect(capturedBody!.userId).toBe('user_01');
        expect(capturedBody!.scopes).toEqual(['calendar:read', 'email:send']);
        expect(capturedBody!.offlineTTL).toBe('48h');
        expect(capturedBody!.offlineAuditKeyAlgorithm).toBe('Ed25519');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('uses default baseUrl and offlineTTL when not specified', async () => {
      const mockBundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      let calledUrl = '';
      let capturedBody: Record<string, unknown> | null = null;
      globalThis.fetch = vi.fn(async (url, init) => {
        calledUrl = url as string;
        capturedBody = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(mockBundle), { status: 200 });
      }) as typeof fetch;

      try {
        await createConsentBundle({
          apiKey: 'key',
          agentId: 'agent_01',
          userId: 'user_01',
          scopes: ['read'],
        });

        expect(calledUrl).toBe('https://api.grantex.dev/v1/consent-bundles');
        expect(capturedBody!.offlineTTL).toBe('72h');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('uses custom baseUrl', async () => {
      const mockBundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      let calledUrl = '';
      globalThis.fetch = vi.fn(async (url) => {
        calledUrl = url as string;
        return new Response(JSON.stringify(mockBundle), { status: 200 });
      }) as typeof fetch;

      try {
        await createConsentBundle({
          apiKey: 'key',
          baseUrl: 'https://custom.api.dev',
          agentId: 'a',
          userId: 'u',
          scopes: [],
        });

        expect(calledUrl).toBe('https://custom.api.dev/v1/consent-bundles');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('strips trailing slash from baseUrl', async () => {
      const mockBundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      let calledUrl = '';
      globalThis.fetch = vi.fn(async (url) => {
        calledUrl = url as string;
        return new Response(JSON.stringify(mockBundle), { status: 200 });
      }) as typeof fetch;

      try {
        await createConsentBundle({
          apiKey: 'key',
          baseUrl: 'https://api.grantex.dev/',
          agentId: 'a',
          userId: 'u',
          scopes: [],
        });

        expect(calledUrl).toBe('https://api.grantex.dev/v1/consent-bundles');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws on HTTP error', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response('Bad Request', { status: 400 }),
      ) as typeof fetch;

      try {
        await expect(
          createConsentBundle({
            apiKey: 'key',
            agentId: 'a',
            userId: 'u',
            scopes: [],
          }),
        ).rejects.toThrow('Failed to create consent bundle: HTTP 400');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('returns bundle with all required fields', async () => {
      const mockBundle = makeBundleFixture();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify(mockBundle), { status: 200 }),
      ) as typeof fetch;

      try {
        const bundle = await createConsentBundle({
          apiKey: 'key',
          agentId: 'a',
          userId: 'u',
          scopes: ['read'],
        });

        expect(bundle.bundleId).toBeTruthy();
        expect(bundle.grantToken).toBeTruthy();
        expect(bundle.jwksSnapshot).toBeDefined();
        expect(bundle.offlineAuditKey).toBeDefined();
        expect(bundle.syncEndpoint).toBeTruthy();
        expect(bundle.offlineExpiresAt).toBeTruthy();
        expect(typeof bundle.checkpointAt).toBe('number');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
