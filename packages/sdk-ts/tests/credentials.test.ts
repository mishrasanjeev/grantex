import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

const MOCK_VC_RECORD = {
  id: 'vc_01',
  grantId: 'grant_01',
  credentialType: 'GrantCredential',
  format: 'vc+sd-jwt',
  credential: 'eyJ0eXAiOiJ2YytzZC1qd3QiLCJhbGciOiJFUzI1NiJ9...',
  status: 'active',
  issuedAt: '2026-03-01T00:00:00Z',
  expiresAt: '2026-03-02T00:00:00Z',
};

const MOCK_VERIFY_RESULT = {
  valid: true,
  credentialType: 'GrantCredential',
  issuer: 'did:web:grantex.dev',
  subject: { principalId: 'user_abc123', agentDid: 'did:grantex:ag_01' },
  expiresAt: '2026-03-02T00:00:00Z',
  revoked: false,
};

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('CredentialsClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('get() GETs /v1/credentials/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_VC_RECORD);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.credentials.get('vc_01');

    expect(result.id).toBe('vc_01');
    expect(result.credentialType).toBe('GrantCredential');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/credentials\/vc_01$/);
  });

  it('list() GETs /v1/credentials with query params', async () => {
    const mockFetch = makeFetch(200, { credentials: [MOCK_VC_RECORD] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.credentials.list({ grantId: 'grant_01', status: 'active' });

    expect(result.credentials).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('/v1/credentials?');
    expect(url).toContain('grantId=grant_01');
    expect(url).toContain('status=active');
  });

  it('list() without params sends GET without query string', async () => {
    const mockFetch = makeFetch(200, { credentials: [] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.credentials.list();

    expect(result.credentials).toHaveLength(0);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/credentials$/);
  });

  it('verify() POSTs to /v1/credentials/verify', async () => {
    const mockFetch = makeFetch(200, MOCK_VERIFY_RESULT);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.credentials.verify('eyJ...');

    expect(result.valid).toBe(true);
    expect(result.credentialType).toBe('GrantCredential');
    expect(result.issuer).toBe('did:web:grantex.dev');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/credentials\/verify$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ credential: 'eyJ...' });
  });

  it('present() POSTs to /v1/credentials/present', async () => {
    const mockPresentResult = {
      valid: true,
      disclosedClaims: { principalId: 'user_abc', scopes: ['read'] },
    };
    const mockFetch = makeFetch(200, mockPresentResult);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.credentials.present({
      sdJwt: 'eyJ...~disc1~disc2~',
      nonce: 'test-nonce',
      audience: 'https://api.example.com',
    });

    expect(result.valid).toBe(true);
    expect(result.disclosedClaims).toEqual({ principalId: 'user_abc', scopes: ['read'] });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/credentials\/present$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.sdJwt).toBe('eyJ...~disc1~disc2~');
    expect(body.nonce).toBe('test-nonce');
    expect(body.audience).toBe('https://api.example.com');
  });

  it('present() returns error for invalid SD-JWT', async () => {
    const mockFetch = makeFetch(200, { valid: false, error: 'Invalid SD-JWT' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.credentials.present({ sdJwt: 'invalid~' });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid SD-JWT');
  });
});
