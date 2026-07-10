import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { setApiKey } from '../client';
import { subscribeToEvents } from '../events';

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read: vi.fn(async () => index < chunks.length
          ? { done: false, value: encoder.encode(chunks[index++]!) }
          : { done: true, value: undefined }),
      }),
    },
  };
}

describe('event stream', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    setApiKey(null);
  });

  it('opens one authenticated SSE request and emits normalized events', async () => {
    setApiKey('gx_test');
    mockFetch.mockResolvedValueOnce(streamResponse([
      ': keepalive\n\n',
      'data: {"id":"evt_1","type":"grant.created","createdAt":"2026-01-01T00:00:00Z","data":{"grantId":"g1"}}\n\n',
    ]));
    const onOpen = vi.fn();
    const onEvent = vi.fn();
    const controller = new AbortController();

    await subscribeToEvents({ signal: controller.signal, onOpen, onEvent });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/events/stream', {
      headers: { Accept: 'text/event-stream', Authorization: 'Bearer gx_test' },
      signal: controller.signal,
    });
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      id: 'evt_1',
      type: 'grant.created',
      createdAt: '2026-01-01T00:00:00Z',
      payload: { grantId: 'g1' },
    });
  });

  it('throws ApiError when the stream request is rejected', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' });
    await expect(subscribeToEvents({
      signal: new AbortController().signal,
      onEvent: vi.fn(),
    })).rejects.toMatchObject({ status: 429, code: 'EVENT_STREAM_ERROR' });
  });
});
