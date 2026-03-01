import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventSource } from '../src/source.js';
import type { EventDestination, GrantexEvent } from '../src/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

function createMockDestination(): EventDestination & { events: GrantexEvent[][] } {
  const events: GrantexEvent[][] = [];
  return {
    name: 'mock',
    events,
    send: vi.fn(async (e) => { events.push(e); }),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('EventSource', () => {
  it('throws on connection failure', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const source = new EventSource({ url: 'https://api.grantex.dev', apiKey: 'bad' });

    await expect(source.start()).rejects.toThrow('Failed to connect to event stream: 401');
  });

  it('stops and flushes destinations', async () => {
    const dest = createMockDestination();
    const source = new EventSource({ url: 'https://api.grantex.dev', apiKey: 'key' });
    source.addDestination(dest);

    await source.stop();

    expect(dest.flush).toHaveBeenCalled();
    expect(dest.close).toHaveBeenCalled();
  });

  it('adds destinations', () => {
    const dest = createMockDestination();
    const source = new EventSource({ url: 'https://api.grantex.dev', apiKey: 'key' });
    source.addDestination(dest);
    // No direct way to assert internal state, but addDestination should not throw
    expect(dest.name).toBe('mock');
  });

  it('constructs URL with types filter', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const source = new EventSource({
      url: 'https://api.grantex.dev',
      apiKey: 'key',
      types: ['grant.created', 'grant.revoked'],
    });

    await source.start().catch(() => {});

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('types=grant.created%2Cgrant.revoked'),
      expect.anything(),
    );
  });

  it('sends authorization header', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const source = new EventSource({ url: 'https://api.grantex.dev', apiKey: 'my-key' });

    await source.start().catch(() => {});

    expect(mockFetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: { Authorization: 'Bearer my-key' },
      }),
    );
  });
});
