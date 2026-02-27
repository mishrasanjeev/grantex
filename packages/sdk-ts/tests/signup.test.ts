import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

const MOCK_SIGNUP_RESPONSE = {
  developerId: 'dev_NEW01',
  apiKey: 'gx_live_abc123',
  name: 'Acme Corp',
  email: null,
  mode: 'live' as const,
  createdAt: '2026-02-27T00:00:00Z',
};

const MOCK_ROTATE_RESPONSE = {
  apiKey: 'gx_live_newkey456',
  rotatedAt: '2026-02-27T01:00:00Z',
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

describe('Grantex.signup()', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs to /v1/signup without auth header', async () => {
    const mockFetch = makeFetch(201, MOCK_SIGNUP_RESPONSE);
    vi.stubGlobal('fetch', mockFetch);

    const result = await Grantex.signup({ name: 'Acme Corp' });

    expect(result.developerId).toBe('dev_NEW01');
    expect(result.apiKey).toBe('gx_live_abc123');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/signup$/);
    expect(init.method).toBe('POST');
    // No Authorization header
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends email in the body when provided', async () => {
    const mockFetch = makeFetch(201, { ...MOCK_SIGNUP_RESPONSE, email: 'dev@acme.com' });
    vi.stubGlobal('fetch', mockFetch);

    const result = await Grantex.signup({ name: 'Acme Corp', email: 'dev@acme.com' });

    expect(result.email).toBe('dev@acme.com');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.email).toBe('dev@acme.com');
  });

  it('uses custom baseUrl', async () => {
    const mockFetch = makeFetch(201, MOCK_SIGNUP_RESPONSE);
    vi.stubGlobal('fetch', mockFetch);

    await Grantex.signup({ name: 'Acme Corp' }, { baseUrl: 'https://custom.api.dev' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://custom.api.dev/v1/signup');
  });

  it('throws on error response', async () => {
    vi.stubGlobal('fetch', makeFetch(409, { message: 'A developer with this email already exists' }));

    await expect(Grantex.signup({ name: 'Acme Corp', email: 'taken@acme.com' }))
      .rejects.toThrow('A developer with this email already exists');
  });
});

describe('Grantex.rotateKey()', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs to /v1/keys/rotate', async () => {
    const mockFetch = makeFetch(200, MOCK_ROTATE_RESPONSE);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.rotateKey();

    expect(result.apiKey).toBe('gx_live_newkey456');
    expect(result.rotatedAt).toBe('2026-02-27T01:00:00Z');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/keys\/rotate$/);
    expect(init.method).toBe('POST');
  });
});
