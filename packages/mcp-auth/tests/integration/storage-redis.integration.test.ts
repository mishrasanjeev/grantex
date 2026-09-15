import { describe, it, expect, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { RedisStorage, fromIoredis } from '../../src/storage/redis.js';
import { describeStorageContract } from '../storage-contract.js';
import { redisUrl } from './env.js';

const skip = !redisUrl;
const keyPrefix = `grantex:mcp-auth:test:${process.pid}:`;

let redis: Redis | undefined;
const getRedis = () => (redis ??= new Redis(redisUrl!, { maxRetriesPerRequest: 1 }));

async function dump(): Promise<string> {
  const client = getRedis();
  const keys = await client.keys(`${keyPrefix}*`);
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(key, (await client.get(key)) ?? '');
  }
  return parts.join('\n');
}

afterAll(async () => {
  if (redis) {
    const keys = await redis.keys(`${keyPrefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  }
});

describeStorageContract(
  'redis (ioredis)',
  async () => ({ storage: new RedisStorage({ redis: fromIoredis(getRedis()), keyPrefix }), dump }),
  { skip },
);

(skip ? describe.skip : describe)('Redis storage (real server)', () => {
  it('sets a TTL matching the record expiry', async () => {
    const storage = new RedisStorage({ redis: fromIoredis(getRedis()), keyPrefix });
    await storage.putConsent('ttl-probe', {
      clientId: 'client-a',
      redirectUri: 'https://app.example.com/callback',
      codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      codeChallengeMethod: 'S256',
      scopes: [],
      csrfTokenHash: 'h',
      browserBindingHash: 'b',
      createdAt: Date.now(),
      expiresAt: Date.now() + 30_000,
    });
    const keys = await getRedis().keys(`${keyPrefix}consent:*`);
    expect(keys).toHaveLength(1);
    const ttl = await getRedis().pttl(keys[0]!);
    expect(ttl).toBeGreaterThan(25_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it('keeps client registrations without a TTL', async () => {
    const storage = new RedisStorage({ redis: fromIoredis(getRedis()), keyPrefix });
    await storage.putClient({
      clientId: 'ttl-client',
      redirectUris: ['https://app.example.com/callback'],
      grantTypes: ['authorization_code'],
      createdAt: new Date().toISOString(),
    });
    expect(await getRedis().pttl(`${keyPrefix}client:ttl-client`)).toBe(-1);
  });

  it('refuses a stored value that is not a JSON object', async () => {
    const storage = new RedisStorage({ redis: fromIoredis(getRedis()), keyPrefix });
    await getRedis().set(`${keyPrefix}client:corrupt`, JSON.stringify('just a string'));
    await expect(storage.getClient('corrupt')).rejects.toThrow(/not a JSON object/);
  });

  it('propagates a connection error instead of reporting "not found"', async () => {
    const broken = new RedisStorage({ redis: { send: async () => { throw new Error('ECONNREFUSED'); } } });
    await expect(broken.consumeAuthorizationCode('any')).rejects.toThrow('ECONNREFUSED');
    await expect(broken.isTokenRevoked('any')).rejects.toThrow('ECONNREFUSED');
  });
});
