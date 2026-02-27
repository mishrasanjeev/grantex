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

describe('TokensClient', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('exchange() POSTs to /v1/token', async () => {
    const mockBody = {
      grantToken: 'eyJ...',
      expiresAt: '2026-03-01T00:00:00Z',
      scopes: ['calendar:read'],
      refreshToken: 'rt_abc',
      grantId: 'grnt_01',
    };
    const mockFetch = makeFetch(200, mockBody);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.tokens.exchange({
      code: 'auth_code_123',
      agentId: 'ag_01',
    });

    expect(result.grantToken).toBe('eyJ...');
    expect(result.grantId).toBe('grnt_01');
    expect(result.scopes).toEqual(['calendar:read']);
    expect(result.refreshToken).toBe('rt_abc');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/token$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.code).toBe('auth_code_123');
    expect(body.agentId).toBe('ag_01');
  });

  it('verify() POSTs to /v1/tokens/verify', async () => {
    const mockBody = {
      valid: true,
      grantId: 'grnt_01',
      scopes: ['calendar:read'],
      principal: 'user_abc',
      agent: 'did:grantex:ag_01',
      expiresAt: '2026-03-01T00:00:00Z',
    };
    const mockFetch = makeFetch(200, mockBody);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.tokens.verify('my.jwt.token');

    expect(result.valid).toBe(true);
    expect(result.grantId).toBe('grnt_01');

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/tokens\/verify$/);
  });

  it('revoke() POSTs to /v1/tokens/revoke', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.tokens.revoke('tok_01')).resolves.toBeUndefined();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/tokens\/revoke$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.jti).toBe('tok_01');
  });
});
