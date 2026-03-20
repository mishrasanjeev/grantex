import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookupOrgTrust, clearTrustRegistryCache } from '../src/trust-registry.js';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('lookupOrgTrust', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearTrustRegistryCache();
  });

  it('returns OrgTrustRecord for a known DID', async () => {
    const fetchMock = mockFetch(200, {
      organizationDID: 'did:web:acme.com',
      verifiedAt: '2026-03-18T00:00:00Z',
      verificationMethod: 'dns-txt',
      trustLevel: 'verified',
      domains: ['acme.com'],
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await lookupOrgTrust('did:web:acme.com', {
      endpoint: 'https://api.grantex.dev/v1/trust-registry',
    });

    expect(result).not.toBeNull();
    expect(result!.organizationDID).toBe('did:web:acme.com');
    expect(result!.trustLevel).toBe('verified');
    expect(result!.verificationMethod).toBe('dns-txt');
    expect(result!.domains).toEqual(['acme.com']);
    expect(result!.verifiedAt).toBeInstanceOf(Date);

    // Verify fetch was called with correct URL
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://api.grantex.dev/v1/trust-registry/did%3Aweb%3Aacme.com');
  });

  it('returns null for an unknown DID', async () => {
    const fetchMock = mockFetch(404, {});
    vi.stubGlobal('fetch', fetchMock);

    const result = await lookupOrgTrust('did:web:unknown.com', {
      endpoint: 'https://api.grantex.dev/v1/trust-registry',
    });

    expect(result).toBeNull();
  });

  it('caches results within cacheMaxAge', async () => {
    const fetchMock = mockFetch(200, {
      organizationDID: 'did:web:cached.com',
      verifiedAt: '2026-03-18T00:00:00Z',
      verificationMethod: 'manual',
      trustLevel: 'basic',
      domains: ['cached.com'],
    });
    vi.stubGlobal('fetch', fetchMock);

    // First call — hits network
    await lookupOrgTrust('did:web:cached.com', {
      endpoint: 'https://api.grantex.dev/v1/trust-registry',
      cacheMaxAge: 3600,
    });

    // Second call — should use cache
    await lookupOrgTrust('did:web:cached.com', {
      endpoint: 'https://api.grantex.dev/v1/trust-registry',
      cacheMaxAge: 3600,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
