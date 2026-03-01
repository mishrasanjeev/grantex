import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventsClient } from '../src/resources/events.js';
import { HttpClient } from '../src/http.js';

function makeHttp() {
  const mockRawGet = vi.fn();
  const http = {
    rawGet: mockRawGet,
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    lastRateLimit: undefined,
  } as unknown as HttpClient;
  return { http, mockRawGet };
}

describe('EventsClient', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('constructs stream URL without types', async () => {
    const { http, mockRawGet } = makeHttp();
    mockRawGet.mockResolvedValueOnce({ ok: false, status: 401 });
    const client = new EventsClient(http);

    await expect(async () => {
      for await (const _ of client.stream()) { break; }
    }).rejects.toThrow('Failed to connect');

    expect(mockRawGet).toHaveBeenCalledWith('/v1/events/stream');
  });

  it('constructs stream URL with types filter', async () => {
    const { http, mockRawGet } = makeHttp();
    mockRawGet.mockResolvedValueOnce({ ok: false, status: 401 });
    const client = new EventsClient(http);

    await expect(async () => {
      for await (const _ of client.stream({ types: ['grant.created'] })) { break; }
    }).rejects.toThrow('Failed to connect');

    expect(mockRawGet).toHaveBeenCalledWith('/v1/events/stream?types=grant.created');
  });

  it('subscribe returns unsubscribe function', () => {
    const { http, mockRawGet } = makeHttp();
    mockRawGet.mockResolvedValueOnce({ ok: false, status: 500 });
    const client = new EventsClient(http);
    const handler = vi.fn();

    const { unsubscribe } = client.subscribe(handler);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
