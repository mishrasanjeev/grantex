import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { processUsageRollup, startUsageRollupWorker } from '../src/workers/usageRollup.js';
import { sqlMock, mockRedis } from './setup.js';

beforeEach(() => {
  vi.useFakeTimers();
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
  mockRedis.get.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

let idCounter = 0;
function newId(): string {
  return `usage_${++idCounter}`;
}

describe('processUsageRollup', () => {
  it('reads developers and rolls up Redis counters to SQL', async () => {
    // SELECT developers
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // Redis get for token_exchanges, authorizations, verifications
    mockRedis.get
      .mockResolvedValueOnce('10')   // token_exchanges
      .mockResolvedValueOnce('20')   // authorizations
      .mockResolvedValueOnce('5');   // verifications
    // INSERT/UPSERT usage_daily row
    sqlMock.mockResolvedValueOnce([]);

    const count = await processUsageRollup(sqlMock as never, mockRedis as never, newId);

    expect(count).toBe(1);
    expect(sqlMock).toHaveBeenCalledTimes(2); // SELECT developers + INSERT
    expect(mockRedis.get).toHaveBeenCalledTimes(3);
  });

  it('skips developers with zero usage', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // All Redis counters return null (zero)
    mockRedis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const count = await processUsageRollup(sqlMock as never, mockRedis as never, newId);

    expect(count).toBe(1); // count tracks processed developers, not skipped
    // Only SELECT developers, no INSERT because total=0
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('handles per-developer errors gracefully', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }, { id: 'dev_2' }]);
    // dev_1: Redis fails
    mockRedis.get.mockRejectedValueOnce(new Error('Redis timeout'));
    // dev_2: works fine
    mockRedis.get
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce('3')
      .mockResolvedValueOnce('1');
    sqlMock.mockResolvedValueOnce([]);

    const count = await processUsageRollup(sqlMock as never, mockRedis as never, newId);

    // dev_1 errored (caught silently), dev_2 succeeded
    expect(count).toBe(1);
  });

  it('processes multiple developers', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }, { id: 'dev_2' }]);
    // dev_1 usage
    mockRedis.get
      .mockResolvedValueOnce('1')
      .mockResolvedValueOnce('2')
      .mockResolvedValueOnce('3');
    sqlMock.mockResolvedValueOnce([]); // INSERT dev_1
    // dev_2 usage
    mockRedis.get
      .mockResolvedValueOnce('4')
      .mockResolvedValueOnce('5')
      .mockResolvedValueOnce('6');
    sqlMock.mockResolvedValueOnce([]); // INSERT dev_2

    const count = await processUsageRollup(sqlMock as never, mockRedis as never, newId);

    expect(count).toBe(2);
  });

  it('returns 0 when no developers exist', async () => {
    sqlMock.mockResolvedValueOnce([]); // no developers

    const count = await processUsageRollup(sqlMock as never, mockRedis as never, newId);

    expect(count).toBe(0);
    expect(mockRedis.get).not.toHaveBeenCalled();
  });
});

describe('startUsageRollupWorker', () => {
  it('creates interval and returns cleanup function', async () => {
    const cleanup = startUsageRollupWorker(sqlMock as never, mockRedis as never, newId, 60_000);

    expect(typeof cleanup).toBe('function');

    // cleanup should not throw
    cleanup();
  });

  it('runs rollup on the configured interval', async () => {
    // First interval run
    sqlMock.mockResolvedValueOnce([]); // no developers
    // Second interval run
    sqlMock.mockResolvedValueOnce([]);

    const cleanup = startUsageRollupWorker(sqlMock as never, mockRedis as never, newId, 30_000);

    // No immediate run for this worker (only setInterval)
    expect(sqlMock).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sqlMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it('handles errors in interval run gracefully', async () => {
    sqlMock.mockRejectedValueOnce(new Error('DB error'));

    const cleanup = startUsageRollupWorker(sqlMock as never, mockRedis as never, newId, 30_000);

    // Should not throw
    await vi.advanceTimersByTimeAsync(30_000);

    cleanup();
  });
});
