import { describe, it, expect, afterEach, vi } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_CREDENTIAL = {
  id: 'vault_01',
  principalId: 'user_123',
  service: 'google',
  credentialType: 'oauth2',
  tokenExpiresAt: '2026-04-01T00:00:00Z',
  metadata: { email: 'test@example.com' },
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

describe('VaultClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('store() POSTs to /v1/vault/credentials', async () => {
    const mockFetch = makeFetch(201, {
      id: 'vault_01',
      principalId: 'user_123',
      service: 'google',
      credentialType: 'oauth2',
      createdAt: '2026-03-01T00:00:00Z',
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.vault.store({
      principalId: 'user_123',
      service: 'google',
      accessToken: 'ya29.access_token',
      refreshToken: 'rt_refresh',
    });

    expect(result.id).toBe('vault_01');
    expect(result.service).toBe('google');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/vault\/credentials$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.principalId).toBe('user_123');
    expect(body.accessToken).toBe('ya29.access_token');
  });

  it('list() GETs /v1/vault/credentials with filters', async () => {
    const mockFetch = makeFetch(200, { credentials: [MOCK_CREDENTIAL] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.vault.list({ principalId: 'user_123', service: 'google' });

    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0]!.service).toBe('google');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('principalId=user_123');
    expect(url).toContain('service=google');
  });

  it('get() GETs /v1/vault/credentials/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_CREDENTIAL);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.vault.get('vault_01');

    expect(result.id).toBe('vault_01');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/vault\/credentials\/vault_01$/);
    expect(init.method).toBe('GET');
  });

  it('delete() DELETEs /v1/vault/credentials/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.vault.delete('vault_01')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/vault\/credentials\/vault_01$/);
    expect(init.method).toBe('DELETE');
  });

  it('exchange() POSTs to /v1/vault/credentials/exchange with grant token', async () => {
    const mockFetch = makeFetch(200, {
      accessToken: 'ya29.real_token',
      service: 'google',
      credentialType: 'oauth2',
      tokenExpiresAt: '2026-04-01T00:00:00Z',
      metadata: {},
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.vault.exchange('grant.jwt.token', { service: 'google' });

    expect(result.accessToken).toBe('ya29.real_token');
    expect(result.service).toBe('google');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/vault\/credentials\/exchange$/);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer grant.jwt.token');
    const body = JSON.parse(init.body as string);
    expect(body.service).toBe('google');
  });

  it('exchange() uses grant token auth, not API key', async () => {
    const mockFetch = makeFetch(200, {
      accessToken: 'token',
      service: 'github',
      credentialType: 'oauth2',
      tokenExpiresAt: null,
      metadata: {},
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'my_api_key' });
    await grantex.vault.exchange('my.grant.token', { service: 'github' });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Exchange should use the grant token, not the API key
    expect(headers['Authorization']).toBe('Bearer my.grant.token');
    expect(headers['Authorization']).not.toContain('my_api_key');
  });

  it('list() works without filters', async () => {
    const mockFetch = makeFetch(200, { credentials: [] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.vault.list();

    expect(result.credentials).toEqual([]);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/vault\/credentials$/);
  });

  it('exchange() throws error with message from response body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ message: 'Insufficient scopes' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(
      grantex.vault.exchange('grant.jwt.token', { service: 'google' }),
    ).rejects.toThrow('Insufficient scopes');
  });

  it('exchange() throws HTTP status fallback when body has no message', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'internal' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(
      grantex.vault.exchange('grant.jwt.token', { service: 'google' }),
    ).rejects.toThrow('HTTP 500');
  });

  it('exchange() throws HTTP status fallback when json parsing fails', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('invalid json')),
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(
      grantex.vault.exchange('grant.jwt.token', { service: 'google' }),
    ).rejects.toThrow('HTTP 502');
  });
});
