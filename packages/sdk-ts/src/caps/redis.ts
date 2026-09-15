/**
 * Redis caps backend: one Lua script reserves every limit atomically.
 *
 * Keys are tenant-scoped and share a hash tag, `grantex:caps:{<tenant>}:...`,
 * so one reservation touches a single Redis Cluster slot. Each counter is a
 * sorted set of `<reservation id>:<units>` members scored by reservation time
 * plus a running total; rolling windows drop members older than the window
 * before checking. Time comes from the Redis server (`TIME`) unless a clock is
 * injected for tests.
 *
 * Operational requirement: run Redis with `maxmemory-policy noeviction`. An
 * evicted counter would forget reservations and let calls exceed a cap.
 *
 * The scripts are byte-identical to the Python SDK's (`grantex/caps/_redis.py`);
 * a test in each SDK checks this.
 */

import { CapExceededError, WINDOW_MS, tenantHash, type CapsBackend, type ResolvedCapLimit } from './meter.js';

// grantex caps redis script v1 begin
export const RESERVE_SCRIPT = `
local now
if ARGV[1] ~= '' then
  now = tonumber(ARGV[1])
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local rid = ARGV[2]
local n = tonumber(ARGV[3])
local case_ttl = tonumber(ARGV[4])
for i = 1, n do
  local a = 4 + (i - 1) * 3
  local limit = tonumber(ARGV[a + 1])
  local window = tonumber(ARGV[a + 2])
  local units = tonumber(ARGV[a + 3])
  local zkey = KEYS[(i - 1) * 2 + 1]
  local skey = KEYS[(i - 1) * 2 + 2]
  local sum = tonumber(redis.call('GET', skey) or '0')
  if window > 0 then
    local expired = redis.call('ZRANGEBYSCORE', zkey, '-inf', now - window)
    if #expired > 0 then
      for _, member in ipairs(expired) do
        sum = sum - tonumber(string.match(member, ':(%d+)$'))
      end
      if sum < 0 then sum = 0 end
      redis.call('ZREMRANGEBYSCORE', zkey, '-inf', now - window)
      redis.call('SET', skey, sum, 'KEEPTTL')
    end
  end
  if sum + units > limit then
    return {0, i, sum}
  end
end
for i = 1, n do
  local a = 4 + (i - 1) * 3
  local window = tonumber(ARGV[a + 2])
  local units = tonumber(ARGV[a + 3])
  local zkey = KEYS[(i - 1) * 2 + 1]
  local skey = KEYS[(i - 1) * 2 + 2]
  redis.call('ZADD', zkey, now, rid .. ':' .. units)
  redis.call('INCRBY', skey, units)
  local ttl = case_ttl
  if window > 0 then ttl = window + 60000 end
  if ttl > 0 then
    redis.call('PEXPIRE', zkey, ttl)
    redis.call('PEXPIRE', skey, ttl)
  end
end
return {1, 0, 0}
`;

export const REFUND_SCRIPT = `
local rid = ARGV[1]
local n = tonumber(ARGV[2])
for i = 1, n do
  local units = ARGV[2 + i]
  local zkey = KEYS[(i - 1) * 2 + 1]
  local skey = KEYS[(i - 1) * 2 + 2]
  if redis.call('ZREM', zkey, rid .. ':' .. units) == 1 then
    local left = redis.call('DECRBY', skey, tonumber(units))
    if left < 0 then redis.call('SET', skey, 0, 'KEEPTTL') end
  end
end
return 1
`;

export const USAGE_SCRIPT = `
local now
if ARGV[1] ~= '' then
  now = tonumber(ARGV[1])
else
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local window = tonumber(ARGV[2])
local sum = tonumber(redis.call('GET', KEYS[2]) or '0')
if window > 0 then
  for _, member in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now - window)) do
    sum = sum - tonumber(string.match(member, ':(%d+)$'))
  end
end
if sum < 0 then sum = 0 end
return sum
`;
// grantex caps redis script v1 end

/** Runs a Lua script. Adapt your client, for example `ioredisRunner(new Redis(url))`. */
export interface RedisScriptRunner {
  evalScript(script: string, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown>;
}

/** Adapter for an ioredis client (`client.eval(script, numKeys, ...keysAndArgs)`). */
export function ioredisRunner(client: {
  eval(script: string, numKeys: number, ...keysAndArgs: (string | number)[]): Promise<unknown>;
}): RedisScriptRunner {
  return {
    evalScript: (script, keys, args) => client.eval(script, keys.length, ...keys, ...args),
  };
}

async function keysFor(tenantId: string, limit: ResolvedCapLimit): Promise<[string, string]> {
  const base = `grantex:caps:{${await tenantHash(tenantId)}}:${limit.key}`;
  return [`${base}:z`, `${base}:s`];
}

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n)) throw new Error('unexpected caps script result');
  return n;
}

export class RedisCapsBackend implements CapsBackend {
  readonly #redis: RedisScriptRunner;
  readonly #caseTtlMs: number;

  /**
   * `caseTtlSeconds` optionally expires per-case counters; by default they never
   * expire, because an expired per-case counter would reset the cap.
   */
  constructor(redis: RedisScriptRunner, options: { caseTtlSeconds?: number } = {}) {
    const ttl = options.caseTtlSeconds;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl <= 0)) {
      throw new Error('caseTtlSeconds must be a positive integer');
    }
    this.#redis = redis;
    this.#caseTtlMs = ttl === undefined ? 0 : ttl * 1000;
  }

  async reserve(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[], nowMs: number | undefined): Promise<void> {
    const keys: string[] = [];
    const args: (string | number)[] = [nowMs === undefined ? '' : String(nowMs), reservationId, limits.length, this.#caseTtlMs];
    for (const limit of limits) {
      keys.push(...(await keysFor(tenantId, limit)));
      args.push(limit.limit, WINDOW_MS[limit.window], limit.units);
    }
    const result = await this.#redis.evalScript(RESERVE_SCRIPT, keys, args);
    if (!Array.isArray(result) || result.length !== 3) throw new Error('unexpected caps script result');
    const [ok, index, used] = result.map(toInt) as [number, number, number];
    if (ok === 1) return;
    const limit = limits[index - 1];
    if (limit === undefined) throw new Error('unexpected caps script result');
    throw new CapExceededError({
      limit: limit.limit, window: limit.window, used, requested: limit.units, scope: limit.scope, kind: limit.kind,
    });
  }

  async refund(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[]): Promise<void> {
    const keys: string[] = [];
    const args: (string | number)[] = [reservationId, limits.length];
    for (const limit of limits) {
      keys.push(...(await keysFor(tenantId, limit)));
      args.push(limit.units);
    }
    await this.#redis.evalScript(REFUND_SCRIPT, keys, args);
  }

  async usage(tenantId: string, limit: ResolvedCapLimit, nowMs: number | undefined): Promise<number> {
    const result = await this.#redis.evalScript(USAGE_SCRIPT, await keysFor(tenantId, limit), [
      nowMs === undefined ? '' : String(nowMs),
      WINDOW_MS[limit.window],
    ]);
    return toInt(result);
  }
}
