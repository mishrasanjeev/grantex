/**
 * Call caps and cost-unit budgets for tool calls.
 *
 * `CapsMeter` reserves units against every applicable counter atomically,
 * before the call that incurs cost. Backends: `RedisCapsBackend` (Lua script,
 * tenant-scoped keys; preferred), `PostgresCapsBackend` (row locks and upserts,
 * for deployments without Redis) and `InMemoryCapsBackend` (**tests only**).
 *
 * There is no automatic failover between backends: two stores would keep two
 * sets of counters and concurrent calls could exceed a cap. If the configured
 * backend is unavailable the meter throws `MeterUnavailableError` and
 * `enforce()` denies. See docs/concepts/caps-and-metering.md.
 */

export {
  CAP_ERROR_CODE,
  CapExceededError,
  CapsConfigurationError,
  CapsMeter,
  MAX_COUNT,
  MeterUnavailableError,
  WINDOW_MS,
  counterKey,
  resolveLimits,
  tenantHash,
  type CapLimit,
  type CapWindow,
  type CapsBackend,
  type CounterUsage,
  type Reservation,
  type ResolvedCapLimit,
} from './meter.js';
export { InMemoryCapsBackend } from './memory.js';
export {
  REFUND_SCRIPT,
  RESERVE_SCRIPT,
  USAGE_SCRIPT,
  RedisCapsBackend,
  ioredisRunner,
  type RedisScriptRunner,
} from './redis.js';
export { CAPS_SCHEMA_SQL, PostgresCapsBackend, type PgClientLike, type PgPoolLike } from './postgres.js';
export {
  CASE_REQUIRED,
  INVALID_CASE_ID,
  INVALID_COST_COMPONENT,
  MALFORMED_GRANT_CAPS,
  buildCapLimits,
  counterId,
  parseGrantCaps,
  type BuildCapLimitsOptions,
} from './limits.js';
