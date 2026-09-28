// SPDX-License-Identifier: Apache-2.0
//
// The revocation feed prune worker (FINDINGS G-66): bounded batches, a per-run
// cap, one instance at a time, and a jittered first run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { revocationFeedSettings } from '../src/lib/revocation-feed/settings.js';
import {
  PRUNE_BATCH_SIZE,
  PRUNE_LOCK_KEY,
  PRUNE_MAX_BATCHES,
  PRUNE_MAX_RUN_MS,
  pruneRevocationFeedOnce,
  pruneStartDelayMs,
  startRevocationFeedPruneWorker,
  stopRevocationFeedPruneWorker,
} from '../src/workers/revocationFeedPrune.js';

type Sql = ReturnType<typeof postgres>;

// prom-client is mocked for every test file (tests/setup.ts), so the prune
// metrics are replaced here with counters whose increments can be read back.
const metrics = vi.hoisted(() => ({ pruned: vi.fn(), runs: vi.fn() }));
vi.mock('../src/lib/revocation-feed/metrics.js', () => ({
  revocationFeedPrunedTotal: { inc: metrics.pruned },
  revocationFeedPruneRunsTotal: { inc: metrics.runs },
}));

interface FakeDb {
  sql: Sql;
  queries: Array<{ text: string; values: unknown[] }>;
  released: number;
  reserved: number;
}

/**
 * A pool whose `reserve()` hands out one session. `locked` is what
 * pg_try_advisory_lock answers; `batches` is what each DELETE removes, in
 * order (then 0); a batch that is an Error is thrown instead.
 */
function fakeDb(options: { locked?: boolean; batches?: Array<number | Error> } = {}): FakeDb {
  const batches = [...(options.batches ?? [])];
  const db: FakeDb = { sql: undefined as unknown as Sql, queries: [], released: 0, reserved: 0 };
  const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    db.queries.push({ text, values });
    if (text.includes('pg_try_advisory_lock')) return [{ locked: options.locked ?? true }];
    if (text.includes('pg_advisory_unlock')) return [{ unlocked: true }];
    if (text.includes('DELETE FROM grant_revocation_events')) {
      const next = batches.length > 0 ? batches.shift()! : 0;
      if (next instanceof Error) throw next;
      return [{ deleted: String(next) }];
    }
    return [];
  };
  const reserved = Object.assign(run, { release: () => { db.released += 1; } });
  const pool = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => run(strings, ...values),
    { reserve: async () => { db.reserved += 1; return reserved; } },
  );
  db.sql = pool as unknown as Sql;
  return db;
}

function fakeLog() {
  const log = {
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    child: () => log,
  };
  return log;
}

const deletes = (db: FakeDb) => db.queries.filter((q) => q.text.includes('DELETE FROM grant_revocation_events'));

const runsWith = (outcome: string) => metrics.runs.mock.calls.filter(([labels]) => labels?.outcome === outcome).length;
const prunedRows = () => metrics.pruned.mock.calls.reduce((sum, [n]) => sum + (n ?? 1), 0);

beforeEach(() => {
  metrics.pruned.mockClear();
  metrics.runs.mockClear();
  vi.stubEnv('REVOCATION_FEED_ENABLED', 'true');
});

afterEach(() => {
  stopRevocationFeedPruneWorker();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('revocation feed prune: bounded batches', () => {
  it('deletes a backlog in batches of PRUNE_BATCH_SIZE, ordered by the created_at index, until a short batch', async () => {
    const db = fakeDb({ batches: [PRUNE_BATCH_SIZE, PRUNE_BATCH_SIZE, 17] });
    const sleep = vi.fn(async () => undefined);
    const result = await pruneRevocationFeedOnce(db.sql, fakeLog(), { sleep });

    expect(result).toEqual({ outcome: 'complete', deleted: 2 * PRUNE_BATCH_SIZE + 17, batches: 3 });
    const statements = deletes(db);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      // One bounded statement per batch: a LIMITed subquery on the created_at
      // index, never a DELETE over the whole table.
      expect(statement.text).toMatch(/ORDER BY created_at/);
      expect(statement.text).toMatch(/LIMIT/);
      expect(statement.values).toContain(PRUNE_BATCH_SIZE);
    }
    // It yields between batches, not after the last.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('keeps the retention rule: only rows created and expired longer than retention ago', async () => {
    vi.stubEnv('REVOCATION_FEED_RETENTION_HOURS', '72');
    const db = fakeDb({ batches: [3] });
    await pruneRevocationFeedOnce(db.sql, fakeLog(), { sleep: async () => undefined });
    const [statement] = deletes(db);
    expect(statement!.text).toMatch(/created_at < NOW\(\) - make_interval\(hours => \?\)/);
    expect(statement!.text).toMatch(/expires_at IS NULL OR expires_at < NOW\(\) - make_interval\(hours => \?\)/);
    expect(statement!.values.filter((v) => v === 72)).toHaveLength(2);
  });

  it('stops at PRUNE_MAX_BATCHES in one run and leaves the rest to the next run', async () => {
    const db = fakeDb({ batches: Array.from({ length: PRUNE_MAX_BATCHES + 10 }, () => PRUNE_BATCH_SIZE) });
    const log = fakeLog();
    const result = await pruneRevocationFeedOnce(db.sql, log, { sleep: async () => undefined });

    expect(result).toEqual({ outcome: 'capped', deleted: PRUNE_MAX_BATCHES * PRUNE_BATCH_SIZE, batches: PRUNE_MAX_BATCHES });
    expect(deletes(db)).toHaveLength(PRUNE_MAX_BATCHES);
    expect(runsWith('capped')).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'revocation', outcome: 'capped', deleted: PRUNE_MAX_BATCHES * PRUNE_BATCH_SIZE }),
      expect.any(String),
    );
  });

  it('stops once the run has taken PRUNE_MAX_RUN_MS, whatever the batch count', async () => {
    const db = fakeDb({ batches: Array.from({ length: 100 }, () => PRUNE_BATCH_SIZE) });
    let clock = 0;
    // Every batch appears to take a third of the budget.
    const now = () => clock;
    const sleep = vi.fn(async () => { clock += Math.ceil(PRUNE_MAX_RUN_MS / 3); });
    const result = await pruneRevocationFeedOnce(db.sql, fakeLog(), { sleep, now });

    expect(result.outcome).toBe('capped');
    expect(result.batches).toBeLessThanOrEqual(4);
    expect(result.batches).toBeGreaterThanOrEqual(3);
  });

  it('logs the rows deleted on every run, including an empty one', async () => {
    const db = fakeDb({ batches: [] });
    const log = fakeLog();
    const result = await pruneRevocationFeedOnce(db.sql, log, { sleep: async () => undefined });
    expect(result).toEqual({ outcome: 'complete', deleted: 0, batches: 1 });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'revocation', outcome: 'complete', deleted: 0, batches: 1 }),
      expect.any(String),
    );
  });
});

describe('revocation feed prune: one instance at a time', () => {
  it('takes a session advisory lock on the fixed key, on the session that deletes, and releases it', async () => {
    const db = fakeDb({ batches: [5] });
    await pruneRevocationFeedOnce(db.sql, fakeLog(), { sleep: async () => undefined });

    expect(PRUNE_LOCK_KEY).toBe('grantex:revocation-feed-prune');
    const texts = db.queries.map((q) => q.text);
    const lockAt = texts.findIndex((t) => t.includes('pg_try_advisory_lock(hashtextextended('));
    const deleteAt = texts.findIndex((t) => t.includes('DELETE FROM grant_revocation_events'));
    const unlockAt = texts.findIndex((t) => t.includes('pg_advisory_unlock(hashtextextended('));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(deleteAt);
    expect(unlockAt).toBeGreaterThan(deleteAt);
    expect(db.queries[lockAt]!.values).toContain(PRUNE_LOCK_KEY);
    expect(db.queries[unlockAt]!.values).toContain(PRUNE_LOCK_KEY);
    expect(db.reserved).toBe(1);
    expect(db.released).toBe(1);
  });

  it('skips the run without deleting anything when another instance holds the lock', async () => {
    const db = fakeDb({ locked: false, batches: [PRUNE_BATCH_SIZE] });
    const log = fakeLog();
    const result = await pruneRevocationFeedOnce(db.sql, log, { sleep: async () => undefined });

    expect(result).toEqual({ outcome: 'skipped_locked', deleted: 0, batches: 0 });
    expect(deletes(db)).toHaveLength(0);
    // It never held the lock, so it must not try to release one.
    expect(db.queries.some((q) => q.text.includes('pg_advisory_unlock'))).toBe(false);
    expect(db.released).toBe(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'revocation', outcome: 'skipped_locked' }),
      expect.stringMatching(/another instance/),
    );
    expect(runsWith('skipped_locked')).toBe(1);
    expect(prunedRows()).toBe(0);
  });

  it('counts pruned rows and completed runs', async () => {
    const db = fakeDb({ batches: [PRUNE_BATCH_SIZE, 250] });
    await pruneRevocationFeedOnce(db.sql, fakeLog(), { sleep: async () => undefined });
    expect(prunedRows()).toBe(PRUNE_BATCH_SIZE + 250);
    expect(runsWith('complete')).toBe(1);
    expect(metrics.runs).toHaveBeenCalledTimes(1);
  });

  it('a failed batch is logged, releases the lock and the session, and never throws', async () => {
    const db = fakeDb({ batches: [PRUNE_BATCH_SIZE, new Error('connection reset')] });
    const log = fakeLog();
    const result = await pruneRevocationFeedOnce(db.sql, log, { sleep: async () => undefined });

    expect(result).toEqual({ outcome: 'failed', deleted: PRUNE_BATCH_SIZE, batches: 1 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ feed: 'revocation', deleted: PRUNE_BATCH_SIZE }),
      expect.stringMatching(/runs again next interval/),
    );
    expect(db.queries.some((q) => q.text.includes('pg_advisory_unlock'))).toBe(true);
    expect(db.released).toBe(1);
    expect(runsWith('failed')).toBe(1);
    // The batch that committed before the failure is still counted.
    expect(prunedRows()).toBe(PRUNE_BATCH_SIZE);
  });

  it('a pool that cannot hand out a session is logged, not thrown', async () => {
    const log = fakeLog();
    const sql = Object.assign(async () => [], {
      reserve: async () => { throw new Error('too many clients'); },
    }) as unknown as Sql;
    await expect(pruneRevocationFeedOnce(sql, log)).resolves.toEqual({ outcome: 'failed', deleted: 0, batches: 0 });
    expect(log.error).toHaveBeenCalled();
  });

  it('does not touch the database while the feed is off', async () => {
    vi.stubEnv('REVOCATION_FEED_ENABLED', 'false');
    const db = fakeDb({ batches: [5] });
    const result = await pruneRevocationFeedOnce(db.sql, fakeLog());
    expect(result).toEqual({ outcome: 'disabled', deleted: 0, batches: 0 });
    expect(db.reserved).toBe(0);
    expect(db.queries).toHaveLength(0);
  });
});

describe('revocation feed prune: jittered first run', () => {
  it('REVOCATION_FEED_PRUNE_JITTER_SECONDS defaults to 300 and is bounded to 0..3600', () => {
    expect(revocationFeedSettings({}).pruneJitterSeconds).toBe(300);
    expect(revocationFeedSettings({ REVOCATION_FEED_PRUNE_JITTER_SECONDS: '0' }).pruneJitterSeconds).toBe(0);
    expect(revocationFeedSettings({ REVOCATION_FEED_PRUNE_JITTER_SECONDS: '3600' }).pruneJitterSeconds).toBe(3600);
    for (const value of ['3601', '-5', 'soon', '1.5']) {
      expect(revocationFeedSettings({ REVOCATION_FEED_PRUNE_JITTER_SECONDS: value }).pruneJitterSeconds).toBe(300);
    }
  });

  it('the start delay is uniform in [0, jitter) and never outside it', () => {
    expect(pruneStartDelayMs(300, () => 0)).toBe(0);
    expect(pruneStartDelayMs(300, () => 0.5)).toBe(150_000);
    expect(pruneStartDelayMs(300, () => 0.999_999_9)).toBeLessThan(300_000);
    expect(pruneStartDelayMs(0, () => 0.9)).toBe(0);
    for (let i = 0; i < 1_000; i += 1) {
      const delay = pruneStartDelayMs(120);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(120_000);
    }
  });

  it('does not prune at boot: the first run waits for the jitter, then runs hourly from there', async () => {
    vi.useFakeTimers();
    vi.stubEnv('REVOCATION_FEED_PRUNE_JITTER_SECONDS', '300');
    const db = fakeDb();
    const hour = 60 * 60_000;
    startRevocationFeedPruneWorker(db.sql, fakeLog(), hour, { random: () => 0.5 });

    // Nothing at all reaches the database at boot.
    await vi.advanceTimersByTimeAsync(0);
    expect(db.queries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(149_999);
    expect(db.queries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.reserved).toBe(1);
    await vi.advanceTimersByTimeAsync(hour - 1);
    expect(db.reserved).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(db.reserved).toBe(2);
    await vi.advanceTimersByTimeAsync(hour);
    expect(db.reserved).toBe(3);

    // Stopping cancels both the pending first run and the hourly timer.
    stopRevocationFeedPruneWorker();
    await vi.advanceTimersByTimeAsync(3 * hour);
    expect(db.reserved).toBe(3);
  });

  it('stopping before the first run cancels it', async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    startRevocationFeedPruneWorker(db.sql, fakeLog(), 60 * 60_000, { random: () => 0.1 });
    stopRevocationFeedPruneWorker();
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(db.queries).toHaveLength(0);
    expect(db.reserved).toBe(0);
  });
});
