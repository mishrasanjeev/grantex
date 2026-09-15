import { Redis } from 'ioredis';
import { RedisStorage, fromIoredis } from '@grantex/mcp-auth/redis';

export function openRedisStorage(redisUrl: string, keyPrefix = 'grantex:mcp-auth:') {
  // Redis 6.2 or later, with AOF or RDB persistence so client registrations
  // (stored without a TTL) survive a Redis restart.
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  const storage = new RedisStorage({ redis: fromIoredis(redis), keyPrefix });

  return {
    storage,
    async close() {
      await redis.quit();
    },
  };
}
