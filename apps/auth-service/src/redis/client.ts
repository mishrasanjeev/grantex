import { Redis } from 'ioredis';
import { config } from '../config.js';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(config.redisUrl, { lazyConnect: true });
    _redis.on('error', (err: Error) => console.error('[redis] connection error:', err.message));
    _redis.on('reconnecting', () => console.log('[redis] reconnecting...'));
  }
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
