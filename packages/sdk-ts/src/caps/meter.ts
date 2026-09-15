/**
 * Caps meter: atomic reservation of call caps and cost-unit budgets.
 * Mirrors the Python SDK's `grantex.caps`; both address the same counters.
 */

export const CAP_ERROR_CODE = 'E1008';

export type CapWindow = 'per_hour' | 'per_day' | 'per_case';

/** `off` skips caps, `warn` allows over-cap calls and reports them, `enforce` denies them. */
export type CapsMode = 'off' | 'warn' | 'enforce';
export const CAPS_MODES: readonly CapsMode[] = ['off', 'warn', 'enforce'];

/** Rolling window length per window name; `per_case` has no time window. */
export const WINDOW_MS: Readonly<Record<CapWindow, number>> = {
  per_hour: 3_600_000,
  per_day: 86_400_000,
  per_case: 0,
};

export const MAX_COUNT = 2147483647;
const TENANT_MAX = 256;
const RESERVATION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** One counter a call is metered against. */
export interface CapLimit {
  /** Counter identity within a tenant; per-case counters must include the case. */
  counter: string;
  limit: number;
  window: CapWindow;
  /** Units this call consumes (default 1). */
  units?: number;
  /** `manifest` or `grant` (default `manifest`). */
  scope?: string;
  /** `calls` or `cost_units` (default `calls`). */
  kind?: string;
}

/** A validated limit with defaults applied. */
export interface ResolvedCapLimit extends Required<CapLimit> {
  /** Stable, fixed-length storage key (SHA-256 hex). */
  key: string;
}

/** Units reserved for one call. Keep it to refund a call proven unsent. */
export interface Reservation {
  reservationId: string;
  tenantId: string;
  limits: readonly ResolvedCapLimit[];
}

export interface CounterUsage {
  limit: ResolvedCapLimit;
  used: number;
  remaining: number;
}

/** A reservation would exceed a cap. `code` is `E1008`. */
export class CapExceededError extends Error {
  readonly code = CAP_ERROR_CODE;
  readonly reason = 'cap_exceeded';
  readonly limit: number;
  readonly window: CapWindow;
  readonly used: number;
  readonly requested: number;
  readonly scope: string;
  readonly kind: string;

  constructor(args: { limit: number; window: CapWindow; used: number; requested: number; scope: string; kind: string }) {
    const noun = args.kind === 'calls' ? 'call' : 'cost unit';
    super(
      `${CAP_ERROR_CODE} cap_exceeded: ${args.scope} ${args.window} ${noun} cap of ${args.limit} reached (${args.used} used, ${args.requested} requested)`,
    );
    this.name = 'CapExceededError';
    this.limit = args.limit;
    this.window = args.window;
    this.used = args.used;
    this.requested = args.requested;
    this.scope = args.scope;
    this.kind = args.kind;
  }
}

/** The caps backend could not answer. Callers must treat the call as denied. */
export class MeterUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MeterUnavailableError';
  }
}

/** Limits or arguments are invalid. `subReason` names why. */
export class CapsConfigurationError extends Error {
  readonly subReason: string;
  constructor(message: string, subReason = 'invalid_limits') {
    super(message);
    this.name = 'CapsConfigurationError';
    this.subReason = subReason;
  }
}

/** Storage for counters. Implementations must be atomic across all limits. */
export interface CapsBackend {
  /** Reserve every limit or none; throw `CapExceededError` naming the first limit exceeded. */
  reserve(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[], nowMs: number | undefined): Promise<void>;
  /** Remove a reservation. Idempotent. */
  refund(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[], nowMs: number | undefined): Promise<void>;
  /** Units currently held by the counter within its window. */
  usage(tenantId: string, limit: ResolvedCapLimit, nowMs: number | undefined): Promise<number>;
}

const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Storage key for a counter; identical to the Python SDK's `CapLimit.key()`. */
export function counterKey(window: CapWindow, counter: string): Promise<string> {
  return sha256Hex(`grantex-caps:v1\0${window}\0${counter}`);
}

/** Fixed-length tenant component for storage keys. */
export async function tenantHash(tenantId: string): Promise<string> {
  return (await sha256Hex(`grantex-caps-tenant:v1\0${tenantId}`)).slice(0, 32);
}

function checkCount(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
    throw new CapsConfigurationError(`${what} must be an integer between 0 and ${MAX_COUNT}`);
  }
  return value;
}

/** Validate a reservation's arguments and apply defaults. */
export async function resolveLimits(tenantId: unknown, limits: readonly CapLimit[]): Promise<ResolvedCapLimit[]> {
  if (typeof tenantId !== 'string' || tenantId.length === 0 || tenantId.length > TENANT_MAX) {
    throw new CapsConfigurationError('tenantId must be a non-empty string of at most 256 characters');
  }
  const resolved: ResolvedCapLimit[] = [];
  const seen = new Set<string>();
  for (const limit of limits) {
    if (typeof limit !== 'object' || limit === null) throw new CapsConfigurationError('limits must be objects');
    if (!Object.prototype.hasOwnProperty.call(WINDOW_MS, limit.window)) {
      throw new CapsConfigurationError(`unknown cap window ${JSON.stringify(limit.window)}`);
    }
    if (typeof limit.counter !== 'string' || limit.counter.length === 0) {
      throw new CapsConfigurationError('a cap counter must be a non-empty string');
    }
    checkCount(limit.limit, 'a cap limit');
    const units = checkCount(limit.units ?? 1, 'reserved units');
    const key = await counterKey(limit.window, limit.counter);
    if (seen.has(key)) throw new CapsConfigurationError(`counter ${JSON.stringify(limit.counter)} appears twice in one reservation`);
    seen.add(key);
    resolved.push({
      counter: limit.counter,
      limit: limit.limit,
      window: limit.window,
      units,
      scope: limit.scope ?? 'manifest',
      kind: limit.kind ?? 'calls',
      key,
    });
  }
  return resolved;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function unavailable(err: unknown): MeterUnavailableError {
  const name = err instanceof Error ? err.name : typeof err;
  return new MeterUnavailableError(`caps backend unavailable: ${name}`, { cause: err });
}

/**
 * Reserve call caps and cost-unit budgets before the call that incurs cost.
 *
 * `reserve()` checks every limit and records the call atomically, so
 * concurrent callers can never exceed a cap. A failed call is **not** refunded
 * by default: a timeout or error does not prove the provider did no work. Call
 * `refundUnsent()` only when the provider call is known not to have been sent.
 * Any backend failure throws `MeterUnavailableError`; callers must deny.
 */
export class CapsMeter {
  readonly #backend: CapsBackend;
  readonly #clock: (() => number) | undefined;

  constructor(backend: CapsBackend, options: { clock?: () => number } = {}) {
    this.#backend = backend;
    this.#clock = options.clock;
  }

  #now(): number | undefined {
    return this.#clock === undefined ? undefined : Math.trunc(this.#clock());
  }

  async reserve(tenantId: string, limits: readonly CapLimit[]): Promise<Reservation> {
    const applied = (await resolveLimits(tenantId, limits)).filter((l) => l.units > 0);
    for (const limit of applied) {
      if (limit.limit === 0) {
        // A cap of zero disables the tool, whatever the backend holds.
        throw new CapExceededError({
          limit: 0, window: limit.window, used: 0, requested: limit.units, scope: limit.scope, kind: limit.kind,
        });
      }
      if (limit.units > limit.limit) {
        // This call alone exceeds the cap; report what the counter holds.
        let used: number;
        try {
          used = await this.#backend.usage(tenantId, limit, this.#now());
        } catch (err) {
          throw unavailable(err);
        }
        throw new CapExceededError({
          limit: limit.limit, window: limit.window, used, requested: limit.units, scope: limit.scope, kind: limit.kind,
        });
      }
    }
    const reservation: Reservation = { reservationId: randomId(), tenantId, limits: applied };
    if (applied.length === 0) return reservation;
    try {
      await this.#backend.reserve(tenantId, reservation.reservationId, applied, this.#now());
    } catch (err) {
      if (err instanceof CapExceededError) throw err;
      throw unavailable(err);
    }
    return reservation;
  }

  /** Release a reservation whose provider call was proven not sent. */
  async refundUnsent(reservation: Reservation): Promise<void> {
    if (!RESERVATION_RE.test(reservation.reservationId)) throw new CapsConfigurationError('invalid reservation id');
    if (reservation.limits.length === 0) return;
    try {
      await this.#backend.refund(reservation.tenantId, reservation.reservationId, reservation.limits, this.#now());
    } catch (err) {
      throw unavailable(err);
    }
  }

  /** Current usage of each counter, for display (consent page, case view). */
  async usage(tenantId: string, limits: readonly CapLimit[]): Promise<CounterUsage[]> {
    const resolved = await resolveLimits(tenantId, limits);
    try {
      const out: CounterUsage[] = [];
      for (const limit of resolved) {
        const used = await this.#backend.usage(tenantId, limit, this.#now());
        out.push({ limit, used, remaining: Math.max(limit.limit - used, 0) });
      }
      return out;
    } catch (err) {
      throw unavailable(err);
    }
  }
}
