import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SplunkDestination } from '../src/destinations/splunk.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

const event = {
  id: 'evt_1',
  type: 'grant.created',
  createdAt: '2026-03-01T00:00:00Z',
  data: { grantId: 'grnt_1' },
};

describe('SplunkDestination', () => {
  it('sends events to Splunk HEC', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const dest = new SplunkDestination({
      hecUrl: 'https://splunk.example.com:8088',
      hecToken: 'token-123',
      batchSize: 1,
    });

    await dest.send([event]);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://splunk.example.com:8088/services/collector/event',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Splunk token-123' }),
      }),
    );
  });

  it('buffers until batch size', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const dest = new SplunkDestination({
      hecUrl: 'https://splunk.example.com:8088',
      hecToken: 'token-123',
      batchSize: 3,
    });

    await dest.send([event]);
    expect(mockFetch).not.toHaveBeenCalled();

    await dest.send([event, event]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws on HEC error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const dest = new SplunkDestination({
      hecUrl: 'https://splunk.example.com:8088',
      hecToken: 'bad-token',
      batchSize: 1,
    });

    await expect(dest.send([event])).rejects.toThrow('Splunk HEC error: 500');
  });

  it('flushes on close', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const dest = new SplunkDestination({
      hecUrl: 'https://splunk.example.com:8088',
      hecToken: 'token-123',
      batchSize: 100,
    });

    await dest.send([event]);
    await dest.close();

    expect(mockFetch).toHaveBeenCalledOnce();
  });
});
