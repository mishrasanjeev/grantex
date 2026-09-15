"""Redis caps backend: one Lua script reserves every limit atomically.

Keys are tenant-scoped and share a hash tag, ``grantex:caps:{<tenant>}:...``,
so one reservation touches a single Redis Cluster slot. Each counter is a
sorted set of ``<reservation id>:<units>`` members scored by reservation time
plus a running total; rolling windows drop members older than the window
before checking. Time comes from the Redis server (``TIME``) unless a clock is
injected for tests.

Requires Redis 6.0 or later (``SET ... KEEPTTL``). Run it with
``maxmemory-policy noeviction``: an evicted counter would forget reservations
and let calls exceed a cap. Per-hour and per-day keys expire one window plus
60 seconds after the last reservation on the counter; per-case keys only with
``case_ttl_seconds``.

The script text is identical in the TypeScript SDK (``caps/redis.ts``).
"""

from __future__ import annotations

from typing import Any, List, Optional, Sequence

from ._meter import WINDOW_MS, CapExceededError, CapLimit, tenant_hash

# grantex caps redis script v1 begin
RESERVE_SCRIPT = """
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
"""

REFUND_SCRIPT = """
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
"""

USAGE_SCRIPT = """
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
"""
# grantex caps redis script v1 end


def _keys(tenant_id: str, limit: CapLimit) -> List[str]:
    base = f"grantex:caps:{{{tenant_hash(tenant_id)}}}:{limit.key()}"
    return [f"{base}:z", f"{base}:s"]


class RedisCapsBackend:
    """Caps counters in Redis.

    ``client`` is a ``redis.Redis`` (or cluster) client from redis-py.
    ``case_ttl_seconds`` optionally expires per-case counters; by default they
    never expire, because an expired per-case counter would reset the cap.
    """

    def __init__(self, client: Any, *, case_ttl_seconds: Optional[int] = None) -> None:
        if case_ttl_seconds is not None and (
            isinstance(case_ttl_seconds, bool) or not isinstance(case_ttl_seconds, int) or case_ttl_seconds <= 0
        ):
            raise ValueError("case_ttl_seconds must be a positive integer")
        self._client = client
        self._case_ttl_ms = 0 if case_ttl_seconds is None else case_ttl_seconds * 1000
        self._reserve = client.register_script(RESERVE_SCRIPT)
        self._refund = client.register_script(REFUND_SCRIPT)
        self._usage = client.register_script(USAGE_SCRIPT)

    def reserve(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        keys: List[str] = []
        args: List[Any] = ["" if now_ms is None else str(now_ms), reservation_id, len(limits), self._case_ttl_ms]
        for limit in limits:
            keys.extend(_keys(tenant_id, limit))
            args.extend([limit.limit, WINDOW_MS[limit.window], limit.units])
        result = self._reserve(keys=keys, args=args)
        if not isinstance(result, (list, tuple)) or len(result) != 3:
            raise RuntimeError("unexpected caps script result")
        ok, index, used = (int(v) for v in result)
        if ok == 1:
            return
        if not 1 <= index <= len(limits):
            raise RuntimeError("unexpected caps script result")
        limit = limits[index - 1]
        raise CapExceededError(
            limit=limit.limit, window=limit.window, used=used,
            requested=limit.units, scope=limit.scope, kind=limit.kind,
        )

    def refund(
        self,
        tenant_id: str,
        reservation_id: str,
        limits: Sequence[CapLimit],
        now_ms: Optional[int],
    ) -> None:
        keys: List[str] = []
        args: List[Any] = [reservation_id, len(limits)]
        for limit in limits:
            keys.extend(_keys(tenant_id, limit))
            args.append(limit.units)
        self._refund(keys=keys, args=args)

    def usage(self, tenant_id: str, limit: CapLimit, now_ms: Optional[int]) -> int:
        result = self._usage(
            keys=_keys(tenant_id, limit),
            args=["" if now_ms is None else str(now_ms), WINDOW_MS[limit.window]],
        )
        return int(result)
