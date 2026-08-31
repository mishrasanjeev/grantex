import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex, GrantexApiError } from '../src/index.js';

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Rate limit headers', () => {
  it('populates lastRateLimit on successful response', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, { agents: [], total: 0, page: 1, pageSize: 20 }, {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '97',
        'x-ratelimit-reset': '1709337600',
      }),
    );

    const client = new Grantex({ apiKey: 'test-key' });
    await client.agents.list();

    expect(client.lastRateLimit).toEqual({
      limit: 100,
      remaining: 97,
      reset: 1709337600,
    });
  });

  it('attaches rateLimit with retryAfter to GrantexApiError on 429', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(429, { message: 'Rate limit exceeded' }, {
        'x-ratelimit-limit': '20',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1709337600',
        'retry-after': '42',
      }),
    );

    const client = new Grantex({ apiKey: 'test-key', maxRetries: 0 });

    try {
      await client.agents.list();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GrantexApiError);
      const apiErr = err as GrantexApiError;
      expect(apiErr.statusCode).toBe(429);
      expect(apiErr.rateLimit).toEqual({
        limit: 20,
        remaining: 0,
        reset: 1709337600,
        retryAfter: 42,
      });
    }
  });

  it('returns undefined lastRateLimit when headers are missing', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, { agents: [], total: 0, page: 1, pageSize: 20 }, {}),
    );

    const client = new Grantex({ apiKey: 'test-key' });
    await client.agents.list();

    expect(client.lastRateLimit).toBeUndefined();
  });

  it('honors Retry-After beyond the exponential-backoff ceiling', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({
          'x-ratelimit-limit': '20',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '42',
          'retry-after': '42',
        }),
        json: () => Promise.resolve({ message: 'Rate limit exceeded' }),
        text: () => Promise.resolve('Rate limit exceeded'),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ agents: [], total: 0, page: 1, pageSize: 20 }),
      } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const client = new Grantex({ apiKey: 'test-key', maxRetries: 1 });
    const request = client.agents.list();
    await vi.advanceTimersByTimeAsync(41_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(request).resolves.toMatchObject({ agents: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
