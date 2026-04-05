import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';
import { GrantexApiError, GrantexAuthError, GrantexNetworkError } from '../src/errors.js';

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
        authRequestId: 'req_1',
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

    it('exposes error code from response body', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch(400, { message: 'Invalid code', code: 'BAD_REQUEST', requestId: 'req_1' }),
      );
      const grantex = new Grantex({ apiKey: 'test_key' });
      try {
        await grantex.agents.list();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrantexApiError);
        const apiErr = err as GrantexApiError;
        expect(apiErr.code).toBe('BAD_REQUEST');
        expect(apiErr.statusCode).toBe(400);
      }
    });

    it('throws GrantexNetworkError when fetch throws', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      );
      const grantex = new Grantex({ apiKey: 'test_key', maxRetries: 0 });
      await expect(grantex.agents.list()).rejects.toBeInstanceOf(GrantexNetworkError);
    });

    it('uses error field from response body when message is absent', async () => {
      vi.stubGlobal(
        'fetch',
        makeFetch(400, { error: 'Bad input data' }),
      );
      const grantex = new Grantex({ apiKey: 'test_key' });
      try {
        await grantex.agents.list();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrantexApiError);
        expect((err as GrantexApiError).message).toBe('Bad input data');
      }
    });

    it('falls back to HTTP status when body has no message or error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        headers: new Headers(),
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.resolve('plain text error'),
      }));
      const grantex = new Grantex({ apiKey: 'test_key' });
      try {
        await grantex.agents.list();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrantexApiError);
        // Falls back to text body; extractErrorMessage sees a string, not object
        expect((err as GrantexApiError).message).toBe('HTTP 422');
      }
    });

    it('falls back to HTTP status when text() also fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: () => Promise.reject(new Error('not json')),
        text: () => Promise.reject(new Error('text failed')),
      }));
      const grantex = new Grantex({ apiKey: 'test_key' });
      try {
        await grantex.agents.list();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrantexApiError);
        expect((err as GrantexApiError).message).toBe('HTTP 500');
      }
    });

    it('throws GrantexNetworkError with timeout message on AbortError', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(abortError),
      );
      const grantex = new Grantex({ apiKey: 'test_key', timeout: 5000, maxRetries: 0 });
      try {
        await grantex.agents.list();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrantexNetworkError);
        expect((err as GrantexNetworkError).message).toContain('timed out');
      }
    });

    it('throws GrantexNetworkError with stringified cause when fetch throws a non-Error value', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue('string error'),
      );
      const grantex = new Grantex({ apiKey: 'test_key', maxRetries: 0 });
      try {
        await grantex.agents.list();
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(GrantexNetworkError);
        expect((err as GrantexNetworkError).message).toBe('Network error: string error');
      }
    });
  });

  describe('Grantex.signup() error handling', () => {
    it('throws error with message from response body', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'Invalid email format' }),
      }));

      await expect(Grantex.signup({ name: 'Test', email: 'bad' }))
        .rejects.toThrow('Invalid email format');
    });

    it('throws HTTP status fallback when body has no message', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('not json')),
      }));

      await expect(Grantex.signup({ name: 'Test' }))
        .rejects.toThrow('HTTP 500');
    });
  });

  describe('rawGet via events.stream', () => {
    it('rawGet() sends Bearer token and returns raw response', async () => {
      const encoder = new TextEncoder();
      const event = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: {} };
      let readCount = 0;
      const reader = {
        read: vi.fn().mockImplementation(() => {
          readCount++;
          if (readCount === 1) {
            return Promise.resolve({
              done: false,
              value: encoder.encode(`data: ${JSON.stringify(event)}\n`),
            });
          }
          return Promise.resolve({ done: true, value: undefined });
        }),
        releaseLock: vi.fn(),
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { getReader: () => reader },
      });
      vi.stubGlobal('fetch', mockFetch);

      const grantex = new Grantex({ apiKey: 'my_key' });
      const events = [];
      for await (const e of grantex.events.stream()) {
        events.push(e);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(event);
      // Verify rawGet sends the Authorization header
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/v1/events/stream');
      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer my_key');
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
