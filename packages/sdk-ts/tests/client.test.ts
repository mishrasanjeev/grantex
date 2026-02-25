import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';
import { GrantexAuthError, GrantexNetworkError } from '../src/errors.js';

function makeFetch(status: number, body: unknown, headers?: Record<string, string>) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers?.[key] ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('Grantex client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws if no API key is provided', () => {
    const saved = process.env['GRANTEX_API_KEY'];
    delete process.env['GRANTEX_API_KEY'];
    expect(() => new Grantex()).toThrow(/API key/);
    if (saved !== undefined) process.env['GRANTEX_API_KEY'] = saved;
  });

  it('constructs with apiKey option', () => {
    expect(() => new Grantex({ apiKey: 'test_key' })).not.toThrow();
  });

  it('constructs resource clients', () => {
    const grantex = new Grantex({ apiKey: 'test_key' });
    expect(grantex.agents).toBeDefined();
    expect(grantex.grants).toBeDefined();
    expect(grantex.tokens).toBeDefined();
    expect(grantex.audit).toBeDefined();
  });

  describe('authorize()', () => {
    it('maps userId → principalId in request body', async () => {
      const mockFetch = makeFetch(200, {
        requestId: 'req_1',
        consentUrl: 'https://consent.grantex.dev/authorize?req=abc',
        agentId: 'ag_1',
        principalId: 'principal_abc',
        scopes: ['calendar:read'],
        expiresIn: '24h',
        expiresAt: '2026-02-26T00:00:00Z',
        status: 'pending',
        createdAt: '2026-02-25T00:00:00Z',
      });
      vi.stubGlobal('fetch', mockFetch);

      const grantex = new Grantex({ apiKey: 'test_key' });
      const result = await grantex.authorize({
        agentId: 'ag_1',
        userId: 'user_abc123',
        scopes: ['calendar:read'],
        expiresIn: '24h',
      });

      expect(result.consentUrl).toContain('consent.grantex.dev');
      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body['principalId']).toBe('user_abc123');
      expect(body).not.toHaveProperty('userId');
    });
  });

  describe('HTTP error handling', () => {
    it('throws GrantexAuthError on 401', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch(401, { message: 'Unauthorized' }),
      );
      const grantex = new Grantex({ apiKey: 'bad_key' });
      await expect(grantex.agents.list()).rejects.toBeInstanceOf(GrantexAuthError);
    });

    it('throws GrantexAuthError on 403', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch(403, { message: 'Forbidden' }),
      );
      const grantex = new Grantex({ apiKey: 'test_key' });
      await expect(grantex.agents.list()).rejects.toBeInstanceOf(GrantexAuthError);
    });

    it('throws GrantexNetworkError when fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      );
      const grantex = new Grantex({ apiKey: 'test_key' });
      await expect(grantex.agents.list()).rejects.toBeInstanceOf(GrantexNetworkError);
    });
  });

  describe('Authorization header', () => {
    it('sends Bearer token with every request', async () => {
      const mockFetch = makeFetch(200, { agents: [], total: 0, page: 1, pageSize: 20 });
      vi.stubGlobal('fetch', mockFetch);

      const grantex = new Grantex({ apiKey: 'my_secret_key' });
      await grantex.agents.list();

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer my_secret_key');
    });

    it('sends correct User-Agent header', async () => {
      const mockFetch = makeFetch(200, { agents: [], total: 0, page: 1, pageSize: 20 });
      vi.stubGlobal('fetch', mockFetch);

      const grantex = new Grantex({ apiKey: 'test_key' });
      await grantex.agents.list();

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['User-Agent']).toBe('@grantex/sdk/0.1.0');
    });
  });
});
