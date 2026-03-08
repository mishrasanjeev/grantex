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

  it('stream() reads SSE data lines and yields parsed events', async () => {
    const { http, mockRawGet } = makeHttp();
    const event1 = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: { grantId: 'g1' } };
    const event2 = { id: 'evt_2', type: 'token.issued', createdAt: '2026-03-01T00:01:00Z', data: { tokenId: 't1' } };

    const encoder = new TextEncoder();
    let index = 0;
    const chunks = [
      `data: ${JSON.stringify(event1)}\n`,
      `data: ${JSON.stringify(event2)}\n`,
    ];
    const reader = {
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]!) });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    const events = [];
    for await (const event of client.stream()) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(event1);
    expect(events[1]).toEqual(event2);
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it('stream() skips malformed JSON in data lines', async () => {
    const { http, mockRawGet } = makeHttp();
    const validEvent = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: {} };

    const encoder = new TextEncoder();
    let index = 0;
    const chunks = [
      `data: not-valid-json\ndata: ${JSON.stringify(validEvent)}\n`,
    ];
    const reader = {
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]!) });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    const events = [];
    for await (const event of client.stream()) {
      events.push(event);
    }

    // Only the valid event should be yielded; malformed one is skipped
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(validEvent);
  });

  it('stream() completes when reader signals done', async () => {
    const { http, mockRawGet } = makeHttp();

    const reader = {
      read: vi.fn().mockResolvedValue({ done: true, value: undefined }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    const events = [];
    for await (const event of client.stream()) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('stream() calls reader.releaseLock() in finally block', async () => {
    const { http, mockRawGet } = makeHttp();
    const event1 = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: {} };

    const encoder = new TextEncoder();
    let index = 0;
    const chunks = [
      `data: ${JSON.stringify(event1)}\n`,
    ];
    const reader = {
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]!) });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    // Break early to trigger finally
    for await (const _ of client.stream()) {
      break;
    }

    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('stream() throws when response is not ok', async () => {
    const { http, mockRawGet } = makeHttp();
    mockRawGet.mockResolvedValueOnce({ ok: false, status: 503, body: null });

    const client = new EventsClient(http);

    await expect(async () => {
      for await (const _ of client.stream()) { /* noop */ }
    }).rejects.toThrow('Failed to connect to event stream: 503');
  });

  it('stream() throws when response body is null', async () => {
    const { http, mockRawGet } = makeHttp();
    mockRawGet.mockResolvedValueOnce({ ok: true, status: 200, body: null });

    const client = new EventsClient(http);

    await expect(async () => {
      for await (const _ of client.stream()) { /* noop */ }
    }).rejects.toThrow('Failed to connect to event stream: 200');
  });

  it('stream() ignores non-data lines', async () => {
    const { http, mockRawGet } = makeHttp();
    const validEvent = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: {} };

    const encoder = new TextEncoder();
    let index = 0;
    const chunks = [
      `: comment line\nevent: grant.created\ndata: ${JSON.stringify(validEvent)}\nid: 123\n\n`,
    ];
    const reader = {
      read: vi.fn().mockImplementation(() => {
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: encoder.encode(chunks[index++]!) });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    const events = [];
    for await (const event of client.stream()) {
      events.push(event);
    }

    // Only lines starting with "data: " are parsed
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(validEvent);
  });

  it('subscribe() stops iteration when unsubscribed mid-stream', async () => {
    const { http, mockRawGet } = makeHttp();
    const event1 = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: {} };
    const event2 = { id: 'evt_2', type: 'grant.revoked', createdAt: '2026-03-01T00:01:00Z', data: {} };

    const encoder = new TextEncoder();
    let callCount = 0;
    let unsubscribeFn: (() => void) | undefined;

    const reader = {
      read: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            done: false,
            value: encoder.encode(`data: ${JSON.stringify(event1)}\n`),
          });
        }
        if (callCount === 2) {
          // Trigger unsubscribe before yielding second event
          unsubscribeFn?.();
          return Promise.resolve({
            done: false,
            value: encoder.encode(`data: ${JSON.stringify(event2)}\n`),
          });
        }
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    const receivedEvents: unknown[] = [];
    const handler = vi.fn().mockImplementation((event: unknown) => {
      receivedEvents.push(event);
    });

    const { unsubscribe } = client.subscribe(handler);
    unsubscribeFn = unsubscribe;

    // Wait for the async loop to process
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The handler should have received event1 but the loop should break after
    // controller.signal.aborted is detected
    expect(receivedEvents).toContainEqual(event1);
  });

  it('subscribe() calls handler with events and unsubscribe stops it', async () => {
    const { http, mockRawGet } = makeHttp();
    const event1 = { id: 'evt_1', type: 'grant.created', createdAt: '2026-03-01T00:00:00Z', data: {} };

    const encoder = new TextEncoder();
    let callCount = 0;
    const reader = {
      read: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            done: false,
            value: encoder.encode(`data: ${JSON.stringify(event1)}\n`),
          });
        }
        // Return done on subsequent reads
        return Promise.resolve({ done: true, value: undefined });
      }),
      releaseLock: vi.fn(),
    };

    mockRawGet.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    });

    const client = new EventsClient(http);
    const handler = vi.fn();

    const { unsubscribe } = client.subscribe(handler);

    // Wait for the async loop to process
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(handler).toHaveBeenCalledWith(event1);
    unsubscribe();
  });
});
