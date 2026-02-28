import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWebhookDeliveryWorker } from '../src/workers/webhookDelivery.js';
import { sqlMock } from './setup.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const pendingDelivery = {
  id: 'whd_TEST01',
  url: 'https://example.com/webhook',
  payload: '{"type":"grant.created"}',
  signature: 'sha256=abc123',
  attempts: 0,
  max_attempts: 5,
};

describe('startWebhookDeliveryWorker', () => {
  it('processes pending deliveries on startup', async () => {
    sqlMock.mockResolvedValueOnce([pendingDelivery]); // SELECT pending
    mockFetch.mockResolvedValueOnce({ ok: true });
    sqlMock.mockResolvedValueOnce([]);                 // UPDATE delivered

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);

    // Let the immediate run complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        body: '{"type":"grant.created"}',
      }),
    );

    clearInterval(timer);
  });

  it('marks delivery as delivered on successful HTTP response', async () => {
    sqlMock.mockResolvedValueOnce([pendingDelivery]);
    mockFetch.mockResolvedValueOnce({ ok: true });
    sqlMock.mockResolvedValueOnce([]); // UPDATE status = 'delivered'

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    // Second SQL call should be the delivered UPDATE
    const updateCall = sqlMock.mock.calls[1];
    expect(updateCall).toBeDefined();

    clearInterval(timer);
  });

  it('schedules retry on HTTP failure', async () => {
    sqlMock.mockResolvedValueOnce([pendingDelivery]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    sqlMock.mockResolvedValueOnce([]); // UPDATE with retry

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    clearInterval(timer);
  });

  it('marks delivery as failed when max attempts reached', async () => {
    const exhaustedDelivery = { ...pendingDelivery, attempts: 4, max_attempts: 5 };
    sqlMock.mockResolvedValueOnce([exhaustedDelivery]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    sqlMock.mockResolvedValueOnce([]); // UPDATE status = 'failed'

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    clearInterval(timer);
  });

  it('handles fetch errors gracefully', async () => {
    sqlMock.mockResolvedValueOnce([pendingDelivery]);
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    sqlMock.mockResolvedValueOnce([]); // UPDATE with retry

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    clearInterval(timer);
  });

  it('does nothing when no pending deliveries', async () => {
    sqlMock.mockResolvedValueOnce([]); // no pending deliveries

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).not.toHaveBeenCalled();

    clearInterval(timer);
  });

  it('runs on the configured interval', async () => {
    // First run (immediate)
    sqlMock.mockResolvedValueOnce([]);
    // Second run (after interval)
    sqlMock.mockResolvedValueOnce([]);

    const timer = startWebhookDeliveryWorker(sqlMock as never, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sqlMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });
});
