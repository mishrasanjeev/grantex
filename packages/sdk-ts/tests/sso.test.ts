import { describe, it, expect, vi, afterEach } from 'vitest';
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

const MOCK_SSO_CONFIG = {
  issuerUrl: 'https://idp.example.com',
  clientId: 'client_abc',
  redirectUri: 'https://app.grantex.dev/sso/callback',
  createdAt: '2026-02-27T00:00:00Z',
  updatedAt: '2026-02-27T00:00:00Z',
};

describe('SsoClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('createConfig() POSTs to /v1/sso/config', async () => {
    const mockFetch = makeFetch(201, MOCK_SSO_CONFIG);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.createConfig({
      issuerUrl: 'https://idp.example.com',
      clientId: 'client_abc',
      clientSecret: 'secret_xyz',
      redirectUri: 'https://app.grantex.dev/sso/callback',
    });

    expect(result.issuerUrl).toBe('https://idp.example.com');
    expect(result.clientId).toBe('client_abc');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/config$/);
    expect(init.method).toBe('POST');
  });

  it('getConfig() GETs /v1/sso/config', async () => {
    const mockFetch = makeFetch(200, MOCK_SSO_CONFIG);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.getConfig();

    expect(result.issuerUrl).toBe('https://idp.example.com');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/config$/);
    expect(init.method).toBe('GET');
  });

  it('deleteConfig() DELETEs /v1/sso/config', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.sso.deleteConfig();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/config$/);
    expect(init.method).toBe('DELETE');
  });

  it('getLoginUrl() GETs /sso/login with org param', async () => {
    const mockFetch = makeFetch(200, { authorizeUrl: 'https://idp.example.com/authorize?client_id=abc' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.getLoginUrl('dev_TEST');

    expect(result.authorizeUrl).toContain('https://idp.example.com/authorize');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sso\/login\?org=dev_TEST$/);
    expect(init.method).toBe('GET');
  });

  it('handleCallback() GETs /sso/callback with code and state', async () => {
    const mockFetch = makeFetch(200, {
      email: 'alice@corp.com',
      name: 'Alice Smith',
      sub: 'idp_user_01',
      developerId: 'dev_TEST',
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.handleCallback('auth_code_xyz', 'state_abc');

    expect(result.email).toBe('alice@corp.com');
    expect(result.developerId).toBe('dev_TEST');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sso/callback');
    expect(url).toContain('code=auth_code_xyz');
    expect(url).toContain('state=state_abc');
    expect(init.method).toBe('GET');
  });
});
