/**
 * Caps meter against real Redis and real Postgres (PRD G-4).
 *
 * Set GRANTEX_CAPS_REDIS_URL and/or GRANTEX_CAPS_POSTGRES_URL. Tests for a
 * backend without a URL are skipped, unless GRANTEX_CAPS_REQUIRE_INTEGRATION=1
 * (set in CI), in which case a missing URL fails the run.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import pg from 'pg';
import {
  CapExceededError,
  CapsMeter,
  MeterUnavailableError,
  PostgresCapsBackend,
  REFUND_SCRIPT,
  RESERVE_SCRIPT,
  RedisCapsBackend,
  USAGE_SCRIPT,
  ioredisRunner,
  tenantHash,
  type CapLimit,
  type CapsBackend,
} from '../src/caps/index.js';

const REDIS_URL = process.env['GRANTEX_CAPS_REDIS_URL'];
const POSTGRES_URL = process.env['GRANTEX_CAPS_POSTGRES_URL'];
const REQUIRED = process.env['GRANTEX_CAPS_REQUIRE_INTEGRATION'] === '1';
if (REQUIRED && (!REDIS_URL || !POSTGRES_URL)) {
  throw new Error('GRANTEX_CAPS_REDIS_URL and GRANTEX_CAPS_POSTGRES_URL are required (GRANTEX_CAPS_REQUIRE_INTEGRATION=1)');
}

const HOUR = 3_600_000;
const T0 = 1_760_000_000_000;

const redisClients: Redis[] = [];
const pools: pg.Pool[] = [];

afterAll(async () => {
  await Promise.all(redisClients.map((c) => c.quit().catch(() => undefined)));
  await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
});

let sharedRedis: { backend: RedisCapsBackend; client: Redis } | undefined;
function redisBackend(): { backend: RedisCapsBackend; client: Redis } {
  if (sharedRedis !== undefined) return sharedRedis;
  // Several connections, so reservations really race on the server.
  const clients = Array.from({ length: 8 }, () => new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }));
  redisClients.push(...clients);
  let next = 0;
  const runner = {
    evalScript: (script: string, keys: readonly string[], args: readonly (string | number)[]) => {
      const client = clients[next++ % clients.length] as Redis;
      return ioredisRunner(client).evalScript(script, keys, args);
    },
  };
  sharedRedis = { backend: new RedisCapsBackend(runner), client: clients[0] as Redis };
  return sharedRedis;
}

let sharedPostgres: Promise<PostgresCapsBackend> | undefined;
function postgresBackend(): Promise<PostgresCapsBackend> {
  sharedPostgres ??= (async () => {
    const pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 50 });
    pools.push(pool);
    const backend = new PostgresCapsBackend(pool);
    await backend.ensureSchema();
    return backend;
  })();
  return sharedPostgres;
}

const tenant = () => `dev_it_${randomUUID().replace(/-/g, '')}`;
const limit = (max: number, window: CapLimit['window'] = 'per_hour', units = 1, counter = 'acme_kyb.verify_business'): CapLimit => ({
  counter,
  limit: max,
  window,
  units,
});

const backends: Array<[string, string | undefined, () => Promise<CapsBackend>]> = [
  ['redis', REDIS_URL, async () => redisBackend().backend],
  ['postgres', POSTGRES_URL, postgresBackend],
];

for (const [name, url, make] of backends) {
  describe.skipIf(!url)(`${name} caps backend`, () => {
    it('fifty parallel calls against a cap of ten', async () => {
      const meter = new CapsMeter(await make());
      const t = tenant();
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, () =>
          meter.reserve(t, [limit(10)]).then(
            () => 'reserved',
            (err: unknown) => {
              if (!(err instanceof CapExceededError)) throw err;
              expect([err.code, err.limit, err.window]).toEqual(['E1008', 10, 'per_hour']);
              return 'cap_exceeded';
            },
          ),
        ),
      );
      expect(outcomes.filter((o) => o === 'reserved')).toHaveLength(10);
      expect(outcomes.filter((o) => o === 'cap_exceeded')).toHaveLength(40);
      expect((await meter.usage(t, [limit(10)]))[0]?.used).toBe(10);
    });

    it('fifty parallel weighted calls across two counters', async () => {
      const meter = new CapsMeter(await make());
      const t = tenant();
      const limits = [limit(10, 'per_case', 1, 'case_01.calls'), limit(30, 'per_day', 3, 'grant.cost_units')];
      const results = await Promise.allSettled(Array.from({ length: 50 }, () => meter.reserve(t, limits)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
      expect((await meter.usage(t, limits)).map((u) => u.used)).toEqual([10, 30]);
    });

    it('rolling window and refund', async () => {
      const c = { now: T0 };
      const meter = new CapsMeter(await make(), { clock: () => c.now });
      const t = tenant();
      const first = await meter.reserve(t, [limit(2)]);
      c.now += HOUR / 2;
      await meter.reserve(t, [limit(2)]);
      await expect(meter.reserve(t, [limit(2)])).rejects.toMatchObject({ used: 2, limit: 2 });
      c.now = T0 + HOUR;
      await meter.reserve(t, [limit(2)]);
      await expect(meter.reserve(t, [limit(2)])).rejects.toBeInstanceOf(CapExceededError);
      await meter.refundUnsent(first);
      await expect(meter.reserve(t, [limit(2)])).rejects.toBeInstanceOf(CapExceededError);
    });

    it('refund releases a live reservation once', async () => {
      const meter = new CapsMeter(await make(), { clock: () => T0 });
      const t = tenant();
      const reservation = await meter.reserve(t, [limit(1, 'per_case')]);
      await meter.refundUnsent(reservation);
      await meter.refundUnsent(reservation);
      expect((await meter.usage(t, [limit(1, 'per_case')]))[0]?.used).toBe(0);
      await meter.reserve(t, [limit(1, 'per_case')]);
      await expect(meter.reserve(t, [limit(1, 'per_case')])).rejects.toBeInstanceOf(CapExceededError);
    });

    it('is all or nothing across counters', async () => {
      const meter = new CapsMeter(await make(), { clock: () => T0 });
      const t = tenant();
      await meter.reserve(t, [limit(1, 'per_hour', 1, 'b')]);
      await expect(meter.reserve(t, [limit(5, 'per_hour', 1, 'a'), limit(1, 'per_hour', 1, 'b')])).rejects.toBeInstanceOf(CapExceededError);
      expect((await meter.usage(t, [limit(5, 'per_hour', 1, 'a')]))[0]?.used).toBe(0);
    });

    it('isolates tenants', async () => {
      const meter = new CapsMeter(await make(), { clock: () => T0 });
      const [a, b] = [tenant(), tenant()];
      await meter.reserve(a, [limit(1)]);
      await meter.reserve(b, [limit(1)]);
      await expect(meter.reserve(a, [limit(1)])).rejects.toBeInstanceOf(CapExceededError);
    });
  });
}

describe.skipIf(!REDIS_URL)('redis keys', () => {
  it('are tenant-scoped with one hash tag', async () => {
    const { backend, client } = redisBackend();
    const t = tenant();
    await new CapsMeter(backend, { clock: () => T0 }).reserve(t, [limit(5, 'per_hour', 1, 'x'), limit(5, 'per_case', 1, 'y')]);
    const keys = (await client.keys(`grantex:caps:{${await tenantHash(t)}}:*`)).sort();
    expect(keys).toHaveLength(4);
    for (const key of keys) expect(key).toMatch(/^grantex:caps:\{[0-9a-f]{32}\}:[0-9a-f]{64}:[zs]$/);
    const ttls = await Promise.all(keys.map((k) => client.pttl(k)));
    expect(ttls.filter((ttl) => ttl > 0)).toHaveLength(2);
  });
});

describe('unreachable backends fail closed', () => {
  it('redis', async () => {
    const client = new Redis({ host: '127.0.0.1', port: 1, maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
    redisClients.push(client);
    const meter = new CapsMeter(new RedisCapsBackend(ioredisRunner(client)));
    await expect(meter.reserve('dev_01', [limit(10)])).rejects.toBeInstanceOf(MeterUnavailableError);
  });

  it('postgres', async () => {
    const pool = new pg.Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 2000 });
    pools.push(pool);
    const meter = new CapsMeter(new PostgresCapsBackend(pool));
    await expect(meter.reserve('dev_01', [limit(10)])).rejects.toBeInstanceOf(MeterUnavailableError);
  });
});

it('the Lua scripts are identical to the Python SDK', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sdk-py', 'src', 'grantex', 'caps', '_redis.py'),
    'utf-8',
  ).replace(/\r\n/g, '\n'); // a Windows checkout may convert line endings
  for (const [name, script] of [
    ['RESERVE_SCRIPT', RESERVE_SCRIPT],
    ['REFUND_SCRIPT', REFUND_SCRIPT],
    ['USAGE_SCRIPT', USAGE_SCRIPT],
  ] as const) {
    const match = new RegExp(`${name} = """([\\s\\S]*?)"""`).exec(source);
    expect(match?.[1], name).toBe(script);
  }
});
