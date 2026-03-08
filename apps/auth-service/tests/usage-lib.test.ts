import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real usage implementation
vi.unmock('../src/lib/usage.js');

// Hoist mock config and redis
const { mockConfig, mockRedisInstance } = vi.hoisted(() => {
  const mockConfig = {
    usageMeteringEnabled: false,
  };
  const mockRedisInstance = {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  };
  return { mockConfig, mockRedisInstance };
});

vi.mock('../src/config.js', () => ({ config: mockConfig }));
vi.mock('../src/redis/client.js', () => ({
  getRedis: () => mockRedisInstance,
}));

import { incrementUsage, getUsageCount, getDailyUsage } from '../src/lib/usage.js';

beforeEach(() => {
  mockConfig.usageMeteringEnabled = false;
  mockRedisInstance.incr.mockReset().mockResolvedValue(1);
  mockRedisInstance.expire.mockReset().mockResolvedValue(1);
  mockRedisInstance.get.mockReset().mockResolvedValue(null);
});

describe('incrementUsage', () => {
  it('does nothing when usageMeteringEnabled is false', async () => {
    mockConfig.usageMeteringEnabled = false;

    await incrementUsage('dev_1', 'token_exchanges');

    expect(mockRedisInstance.incr).not.toHaveBeenCalled();
  });

  it('increments redis counter when enabled', async () => {
    mockConfig.usageMeteringEnabled = true;

    await incrementUsage('dev_1', 'token_exchanges');

    expect(mockRedisInstance.incr).toHaveBeenCalledOnce();
    expect(mockRedisInstance.expire).toHaveBeenCalledOnce();
  });

  it('catches Redis errors silently', async () => {
    mockConfig.usageMeteringEnabled = true;
    mockRedisInstance.incr.mockRejectedValueOnce(new Error('Redis down'));

    // Should not throw
    await expect(incrementUsage('dev_1', 'authorizations')).resolves.toBeUndefined();
  });

  it('sets TTL of 48 hours on the key', async () => {
    mockConfig.usageMeteringEnabled = true;

    await incrementUsage('dev_1', 'verifications');

    expect(mockRedisInstance.expire).toHaveBeenCalledWith(
      expect.stringContaining('usage:dev_1:verifications:'),
      172800,
    );
  });
});

describe('getUsageCount', () => {
  it('returns 0 when key does not exist', async () => {
    mockRedisInstance.get.mockResolvedValueOnce(null);

    const count = await getUsageCount('dev_1', 'token_exchanges');
    expect(count).toBe(0);
  });

  it('returns parsed integer value', async () => {
    mockRedisInstance.get.mockResolvedValueOnce('42');

    const count = await getUsageCount('dev_1', 'authorizations');
    expect(count).toBe(42);
  });
});

describe('getDailyUsage', () => {
  it('returns all three metrics', async () => {
    mockRedisInstance.get
      .mockResolvedValueOnce('10')   // token_exchanges
      .mockResolvedValueOnce('20')   // authorizations
      .mockResolvedValueOnce('30');  // verifications

    const usage = await getDailyUsage('dev_1');

    expect(usage).toEqual({
      token_exchanges: 10,
      authorizations: 20,
      verifications: 30,
    });
  });
});
