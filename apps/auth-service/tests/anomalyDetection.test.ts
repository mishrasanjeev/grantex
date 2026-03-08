import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAnomalyDetectionWorker } from '../src/workers/anomalyDetection.js';
import { sqlMock } from './setup.js';

beforeEach(() => {
  vi.useFakeTimers();
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startAnomalyDetectionWorker', () => {
  it('runs detection immediately on startup', async () => {
    // SELECT developers
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    // At minimum the SELECT developers query was called
    expect(sqlMock).toHaveBeenCalledTimes(1);

    clearInterval(timer);
  });

  it('runs detection on the configured interval', async () => {
    // First run (immediate): no developers
    sqlMock.mockResolvedValueOnce([]);
    // Second run (after interval): no developers
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sqlMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    clearInterval(timer);
  });

  it('detects rate_spike anomaly (>50 actions/hour)', async () => {
    // SELECT developers
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // 4 anomaly detection queries for dev_1:
    // rate_spike: return a row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_1', count: '75' }]);
    // high_failure_rate: none
    sqlMock.mockResolvedValueOnce([]);
    // new_principal: none
    sqlMock.mockResolvedValueOnce([]);
    // off_hours: none
    sqlMock.mockResolvedValueOnce([]);
    // DELETE existing anomalies
    sqlMock.mockResolvedValueOnce([]);
    // INSERT anomaly row
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    // 1 (developers) + 4 (detection queries) + 1 (delete) + 1 (insert) = 7
    expect(sqlMock).toHaveBeenCalledTimes(7);

    clearInterval(timer);
  });

  it('detects high_failure_rate anomaly (>20% failure)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // rate_spike: none
    sqlMock.mockResolvedValueOnce([]);
    // high_failure_rate: return a row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_2', bad_count: '5', total_count: '10' }]);
    // new_principal: none
    sqlMock.mockResolvedValueOnce([]);
    // off_hours: none
    sqlMock.mockResolvedValueOnce([]);
    // DELETE existing anomalies
    sqlMock.mockResolvedValueOnce([]);
    // INSERT anomaly row
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sqlMock).toHaveBeenCalledTimes(7);

    clearInterval(timer);
  });

  it('detects new_principal anomaly', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // rate_spike: none
    sqlMock.mockResolvedValueOnce([]);
    // high_failure_rate: none
    sqlMock.mockResolvedValueOnce([]);
    // new_principal: return a row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_3', principal_id: 'user_new' }]);
    // off_hours: none
    sqlMock.mockResolvedValueOnce([]);
    // DELETE existing anomalies
    sqlMock.mockResolvedValueOnce([]);
    // INSERT anomaly row
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sqlMock).toHaveBeenCalledTimes(7);

    clearInterval(timer);
  });

  it('detects off_hours_activity anomaly (22:00-06:00 UTC)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // rate_spike: none
    sqlMock.mockResolvedValueOnce([]);
    // high_failure_rate: none
    sqlMock.mockResolvedValueOnce([]);
    // new_principal: none
    sqlMock.mockResolvedValueOnce([]);
    // off_hours: return a row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_4', count: '15' }]);
    // DELETE existing anomalies
    sqlMock.mockResolvedValueOnce([]);
    // INSERT anomaly row
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(sqlMock).toHaveBeenCalledTimes(7);

    clearInterval(timer);
  });

  it('does nothing when no anomalies detected (clean state)', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // All 4 detection queries return empty
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    // No DELETE or INSERT should happen

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    // Only 1 (developers) + 4 (detection queries) = 5
    expect(sqlMock).toHaveBeenCalledTimes(5);

    clearInterval(timer);
  });

  it('detects multiple anomaly types simultaneously', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }]);
    // rate_spike: 1 row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_1', count: '100' }]);
    // high_failure_rate: 1 row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_2', bad_count: '8', total_count: '10' }]);
    // new_principal: 1 row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_3', principal_id: 'user_new' }]);
    // off_hours: 1 row
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_4', count: '20' }]);
    // DELETE existing anomalies
    sqlMock.mockResolvedValueOnce([]);
    // INSERT 4 anomaly rows
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    // 1 (developers) + 4 (detection) + 1 (delete) + 4 (inserts) = 10
    expect(sqlMock).toHaveBeenCalledTimes(10);

    clearInterval(timer);
  });

  it('processes multiple developers', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'dev_1' }, { id: 'dev_2' }]);
    // Dev 1: all clean
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    // Dev 2: all clean
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    // 1 (developers) + 4 (dev_1) + 4 (dev_2) = 9
    expect(sqlMock).toHaveBeenCalledTimes(9);

    clearInterval(timer);
  });

  it('handles errors in detection gracefully', async () => {
    // The first immediate run fails
    sqlMock.mockRejectedValueOnce(new Error('DB connection lost'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const timer = startAnomalyDetectionWorker(sqlMock as never, 60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[anomaly-detection] Error on initial run:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
    clearInterval(timer);
  });

  it('handles errors in interval run gracefully', async () => {
    // Immediate run: success, no developers
    sqlMock.mockResolvedValueOnce([]);
    // Interval run: fails
    sqlMock.mockRejectedValueOnce(new Error('DB down'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const timer = startAnomalyDetectionWorker(sqlMock as never, 30_000);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[anomaly-detection] Error running detection:',
      expect.any(Error),
    );

    consoleSpy.mockRestore();
    clearInterval(timer);
  });
});
