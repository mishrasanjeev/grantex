import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWebhookDeliveryWorker } from '../src/workers/webhookDelivery.js';
import { sqlMock } from './setup.js';
import { setSafeFetchForTests } from '../src/lib/url-security.js';

const mockSafeFetch = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  mockSafeFetch.mockReset();
  setSafeFetchForTests(mockSafeFetch);
});

afterEach(() => {
  vi.useRealTimers();
  setSafeFetchForTests(null);
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
    mockSafeFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
    sqlMock.mockResolvedValueOnce([]);                 // UPDATE delivered

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);

    // Let the immediate run complete
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({
        method: 'POST',
        body: '{"type":"grant.created"}',
      }),
      expect.objectContaining({
        allowedProtocols: ['https:', 'http:'],
      }),
      undefined,
    );
    const claimSql = (sqlMock.mock.calls[0]?.[0] as TemplateStringsArray).join(' ');
    expect(claimSql).toContain('FOR UPDATE SKIP LOCKED');
    expect(claimSql).toContain('UPDATE webhook_deliveries');
    expect(claimSql).toContain("INTERVAL '2 minutes'");
    expect(sqlMock.mock.calls[0]?.slice(1)).toContain(20);

    clearInterval(timer);
  });

  it('marks delivery as delivered on successful HTTP response', async () => {
    sqlMock.mockResolvedValueOnce([pendingDelivery]);
    mockSafeFetch.mockResolvedValueOnce(new Response('', { status: 200 }));
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
    mockSafeFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    sqlMock.mockResolvedValueOnce([]); // UPDATE with retry

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sqlMock.mock.calls[1]?.slice(1)).toContain('30 seconds');

    clearInterval(timer);
  });

  it('marks delivery as failed when max attempts reached', async () => {
    const exhaustedDelivery = { ...pendingDelivery, attempts: 4, max_attempts: 5 };
    sqlMock.mockResolvedValueOnce([exhaustedDelivery]);
    mockSafeFetch.mockResolvedValueOnce(new Response('', { status: 503 }));
    sqlMock.mockResolvedValueOnce([]); // UPDATE status = 'failed'

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    clearInterval(timer);
  });

  it('handles fetch errors gracefully', async () => {
    sqlMock.mockResolvedValueOnce([pendingDelivery]);
    mockSafeFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    sqlMock.mockResolvedValueOnce([]); // UPDATE with retry

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    clearInterval(timer);
  });

  it('does nothing when no pending deliveries', async () => {
    sqlMock.mockResolvedValueOnce([]); // no pending deliveries

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(mockSafeFetch).not.toHaveBeenCalled();

    clearInterval(timer);
  });

  it('logs error when initial processDeliveries rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sqlMock.mockRejectedValueOnce(new Error('DB connection lost'));

    const timer = startWebhookDeliveryWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[webhook-delivery] Error on initial run:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
    clearInterval(timer);
  });

  it('logs error when interval processDeliveries rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Initial run succeeds
    sqlMock.mockResolvedValueOnce([]);
    // Interval run fails
    sqlMock.mockRejectedValueOnce(new Error('DB connection lost'));

    const timer = startWebhookDeliveryWorker(sqlMock as never, 10_000);
    await vi.advanceTimersByTimeAsync(0); // initial run
    await vi.advanceTimersByTimeAsync(10_000); // interval run

    expect(consoleSpy).toHaveBeenCalledWith(
      '[webhook-delivery] Error processing deliveries:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
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

  it('does not overlap polling cycles while a delivery batch is still running', async () => {
    let resolveFetch!: (response: Response) => void;
    sqlMock.mockResolvedValueOnce([pendingDelivery]);
    mockSafeFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    const timer = startWebhookDeliveryWorker(sqlMock as never, 1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sqlMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sqlMock).toHaveBeenCalledTimes(1);

    sqlMock.mockResolvedValueOnce([]); // Mark delivered
    resolveFetch(new Response('', { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    sqlMock.mockResolvedValueOnce([]); // Next interval claim
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sqlMock).toHaveBeenCalledTimes(3);

    clearInterval(timer);
  });
});
