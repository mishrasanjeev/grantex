/**
 * In-process caps backend. **For tests only.**
 *
 * Counters live in one process's memory: they are not shared between workers,
 * are lost on restart, and would let a multi-process deployment exceed every
 * cap. Use the Redis or Postgres backend in any deployment.
 */

import { CapExceededError, WINDOW_MS, tenantHash, type CapsBackend, type ResolvedCapLimit } from './meter.js';

interface Entry {
  at: number;
  reservationId: string;
  units: number;
}

export class InMemoryCapsBackend implements CapsBackend {
  readonly #counters = new Map<string, Entry[]>();

  async #entries(tenantId: string, limit: ResolvedCapLimit, now: number): Promise<Entry[]> {
    const id = `${await tenantHash(tenantId)}:${limit.key}`;
    let entries = this.#counters.get(id);
    if (entries === undefined) {
      entries = [];
      this.#counters.set(id, entries);
    }
    const window = WINDOW_MS[limit.window];
    if (window > 0) {
      const live = entries.filter((e) => e.at > now - window);
      entries.splice(0, entries.length, ...live);
    }
    return entries;
  }

  async reserve(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[], nowMs: number | undefined): Promise<void> {
    const now = nowMs ?? Date.now();
    // Resolve every counter before checking, then check and record with no
    // await in between: JavaScript runs this block without interleaving.
    const all: Entry[][] = [];
    for (const limit of limits) all.push(await this.#entries(tenantId, limit, now));
    limits.forEach((limit, i) => {
      const used = (all[i] as Entry[]).reduce((sum, e) => sum + e.units, 0);
      if (used + limit.units > limit.limit) {
        throw new CapExceededError({
          limit: limit.limit, window: limit.window, used, requested: limit.units, scope: limit.scope, kind: limit.kind,
        });
      }
    });
    limits.forEach((limit, i) => {
      (all[i] as Entry[]).push({ at: now, reservationId, units: limit.units });
    });
  }

  async refund(tenantId: string, reservationId: string, limits: readonly ResolvedCapLimit[]): Promise<void> {
    for (const limit of limits) {
      const entries = this.#counters.get(`${await tenantHash(tenantId)}:${limit.key}`);
      if (entries === undefined) continue;
      const kept = entries.filter((e) => e.reservationId !== reservationId);
      entries.splice(0, entries.length, ...kept);
    }
  }

  async usage(tenantId: string, limit: ResolvedCapLimit, nowMs: number | undefined): Promise<number> {
    return (await this.#entries(tenantId, limit, nowMs ?? Date.now())).reduce((sum, e) => sum + e.units, 0);
  }
}
