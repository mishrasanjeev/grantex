import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatadogDestination } from '../src/destinations/datadog.js';

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

describe('DatadogDestination', () => {
  it('sends events to Datadog Logs API', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const dest = new DatadogDestination({ apiKey: 'dd-key', batchSize: 1 });

    await dest.send([event]);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('datadoghq.com'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('buffers events until batch size', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const dest = new DatadogDestination({ apiKey: 'dd-key', batchSize: 5 });

    await dest.send([event]);
    expect(mockFetch).not.toHaveBeenCalled();

    await dest.send([event, event, event, event]);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('flushes remaining events on close', async () => {
    mockFetch.mockResolvedValue({ ok: true });
    const dest = new DatadogDestination({ apiKey: 'dd-key', batchSize: 100 });

    await dest.send([event]);
    await dest.close();

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws on API error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const dest = new DatadogDestination({ apiKey: 'bad-key', batchSize: 1 });

    await expect(dest.send([event])).rejects.toThrow('Datadog API error: 403');
  });

  it('uses custom site', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const dest = new DatadogDestination({ apiKey: 'key', site: 'datadoghq.eu', batchSize: 1 });

    await dest.send([event]);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('datadoghq.eu'),
      expect.anything(),
    );
  });

  it('does nothing on flush when buffer is empty', async () => {
    const dest = new DatadogDestination({ apiKey: 'key' });
    await dest.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
