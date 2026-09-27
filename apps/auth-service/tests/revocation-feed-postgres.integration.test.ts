import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { RevocationFeedHub } from '../src/lib/revocation-feed/hub.js';
import { PRUNE_LOCK_KEY, pruneRevocationFeedOnce } from '../src/workers/revocationFeedPrune.js';
import {
  MAX_PAGE,
  feedReady,
  headSeq,
  pruneFeedBatch,
  readSince,
  resetFeedReadyCache,
  revocationStatus,
  settledCursor,
  snapshotPage,
  type FeedEntry,
} from '../src/lib/revocation-feed/store.js';
import { createTestDatabase } from './helpers/database.js';

// This file runs against a database of its own. Sharing one database across
// the Postgres integration files let `CREATE INDEX CONCURRENTLY` in one file
// deadlock against another file's migration run (FINDINGS G-24).
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres revocation feed tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

type Sql = ReturnType<typeof postgres>;

const log = {
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  child: () => log,
};

interface Fixture {
  sql: Sql;
  dev: string;
  other: string;
  grant: (developerId: string, label: string, parent?: string | null) => Promise<string>;
  token: (grantId: string, label: string) => Promise<string>;
}

async function withFixture<T>(fn: (f: Fixture) => Promise<T>): Promise<T> {
  const sql = postgres(databaseUrl!, { max: 8, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const dev = `dev_feed_${suffix}`;
  const other = `dev_feed_other_${suffix}`;
  const agent = `ag_feed_${suffix}`;
  const migrationLock = await sql.reserve();
  try {
    await runMigrations(sql);
    // Startup re-runs ALTER TABLE ... IF NOT EXISTS on `grants`; hold the
    // migration lock in shared mode so a parallel test file's migration run
    // cannot take it while this file holds row locks on the same table.
    await migrationLock`SELECT pg_advisory_lock_shared(hashtextextended('grantex:migrations', 0))`;
    resetFeedReadyCache();
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
      (${dev}, ${'hash_' + suffix}, 'Feed Test'), (${other}, ${'hash_other_' + suffix}, 'Other Developer')`;
    await sql`INSERT INTO agents (id, did, developer_id, name) VALUES
      (${agent}, ${'did:grantex:' + agent}, ${dev}, 'Agent'),
      (${agent + '_o'}, ${'did:grantex:' + agent + '_o'}, ${other}, 'Other Agent')`;

    const grant = async (developerId: string, label: string, parent: string | null = null): Promise<string> => {
      const id = `grnt_feed_${label}_${suffix}`;
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id)
        VALUES (${id}, ${developerId === dev ? agent : agent + '_o'}, 'user_1', ${developerId},
                ${['tool:acme_kyb:read']}, NOW() + INTERVAL '2 hours', ${parent})`;
      return id;
    };
    const token = async (grantId: string, label: string): Promise<string> => {
      const jti = `tok_feed_${label}_${suffix}`;
      await sql`INSERT INTO grant_tokens (jti, grant_id, expires_at) VALUES (${jti}, ${grantId}, NOW() + INTERVAL '1 hour')`;
      return jti;
    };

    return await fn({ sql, dev, other, grant, token });
  } finally {
    await sql`DELETE FROM grant_revocation_events WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM grant_tokens WHERE grant_id IN (SELECT id FROM grants WHERE developer_id IN (${dev}, ${other}))`.catch(() => undefined);
    await sql`DELETE FROM grants WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM agents WHERE developer_id IN (${dev}, ${other})`.catch(() => undefined);
    await sql`DELETE FROM developers WHERE id IN (${dev}, ${other})`.catch(() => undefined);
    await migrationLock`SELECT pg_advisory_unlock_shared(hashtextextended('grantex:migrations', 0))`.catch(() => undefined);
    migrationLock.release();
    await sql.end();
  }
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('revocation-feed');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await dropTestDatabase?.();
}, 60_000);

describePostgres('the revocation feed against real Postgres', () => {
  it('records every way a grant stops, and nothing else', async () => {
    await withFixture(async ({ sql, dev, grant, token }) => {
      expect(await feedReady(sql)).toBe(true);
      const root = await grant(dev, 'root');
      const child = await grant(dev, 'child', root);
      const jti = await token(child, 'a');

      // Any path that changes the status writes an entry, whoever runs it.
      await sql`UPDATE grants SET status = 'suspended' WHERE id = ${child}`;
      await sql`UPDATE grants SET status = 'active' WHERE id = ${child}`;
      await sql`UPDATE grant_tokens SET is_revoked = TRUE WHERE jti = ${jti}`;
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id IN (${root}, ${child})`;
      // Writes that change nothing add nothing.
      await sql`UPDATE grants SET status = 'revoked' WHERE id = ${root}`;
      await sql`UPDATE grant_tokens SET is_revoked = TRUE WHERE jti = ${jti}`;
      await sql`UPDATE grants SET scopes = ${['tool:acme_kyb:read']} WHERE id = ${root}`;

      const entries = await readSince(sql, dev, 0);
      expect(entries.map((entry) => entry.action)).toEqual(['suspended', 'resumed', 'token_revoked', 'revoked', 'revoked']);
      expect(entries[2]!.jti).toBe(jti);
      expect(entries[2]!.grantId).toBe(child);
      expect(entries.every((entry) => entry.expiresAt !== null)).toBe(true);
      expect(entries.map((entry) => entry.seq)).toEqual([...entries].sort((a, b) => a.seq - b.seq).map((e) => e.seq));
    });
  }, 180_000);

  it('keeps one developer\'s feed out of another\'s', async () => {
    await withFixture(async ({ sql, dev, other, grant }) => {
      const ours = await grant(dev, 'ours');
      const theirs = await grant(other, 'theirs');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id IN (${ours}, ${theirs})`;

      const ourFeed = await readSince(sql, dev, 0);
      expect(ourFeed.map((entry) => entry.grantId)).toEqual([ours]);
      const theirFeed = await readSince(sql, other, 0);
      expect(theirFeed.map((entry) => entry.grantId)).toEqual([theirs]);
      // And the status endpoint's query refuses to answer across the boundary.
      expect(await revocationStatus(sql, dev, theirs, null)).toMatchObject({ status: 'unknown', revoked: true });
    });
  }, 180_000);

  it('never advances the cursor past an entry that could still be overtaken', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const id = await grant(dev, 'settle');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${id}`;
      const head = await headSeq(sql, dev);
      expect(head).toBeGreaterThan(0);

      // With a settle window the entry is delivered but the cursor stays put,
      // so an older sequence number committing late is still read.
      expect(await settledCursor(sql, dev, 0, 60)).toBe(0);
      expect((await readSince(sql, dev, 0)).length).toBe(1);
      // Once it settles the cursor moves.
      expect(await settledCursor(sql, dev, 0, 0)).toBe(head);
    });
  }, 180_000);

  it('serves a paged snapshot of everything currently revoked or suspended', async () => {
    await withFixture(async ({ sql, dev, grant, token }) => {
      const a = await grant(dev, 'a');
      const b = await grant(dev, 'b');
      const live = await grant(dev, 'live');
      const jti = await token(live, 'live');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${a}`;
      await sql`UPDATE grants SET status = 'suspended' WHERE id = ${b}`;
      await sql`UPDATE grant_tokens SET is_revoked = TRUE WHERE jti = ${jti}`;
      // An expired revoked grant is not worth carrying: its token cannot verify.
      const old = await grant(dev, 'old');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW(), expires_at = NOW() - INTERVAL '1 hour' WHERE id = ${old}`;

      const first = await snapshotPage(sql, dev, undefined, 1);
      expect(first.entries).toHaveLength(1);
      expect(first.nextPageToken).not.toBeNull();
      const collected: FeedEntry[] = [...first.entries];
      let token_ = first.nextPageToken;
      while (token_ !== null) {
        const page = await snapshotPage(sql, dev, token_, 1);
        collected.push(...page.entries);
        token_ = page.nextPageToken;
      }
      expect(collected.map((entry) => [entry.grantId, entry.action, entry.jti])).toEqual([
        [a, 'revoked', null],
        [b, 'suspended', null],
        [live, 'token_revoked', jti],
      ]);
      expect(collected.some((entry) => entry.grantId === old)).toBe(false);
    });
  }, 180_000);

  it('delivers a revocation to a live subscriber and reports how fresh it is', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const hub = new RevocationFeedHub(sql, log);
      const seen: FeedEntry[] = [];
      let lastFresh = 0;
      const unsubscribe = hub.subscribe(dev, (batch) => {
        seen.push(...batch.entries);
        lastFresh = batch.freshAt;
      });
      try {
        await hub.pollNow(dev);
        const id = await grant(dev, 'live');
        await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${id}`;

        // `pollNow` is a no-op while the hub's own interval poll is in
        // flight, so wait for the delivery rather than assume one poll.
        const deadline = Date.now() + 10_000;
        while (seen.length === 0 && Date.now() < deadline) {
          await hub.pollNow(dev);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(seen.map((entry) => entry.grantId)).toEqual([id]);
        expect(Date.now() - lastFresh).toBeLessThan(5_000);

        // The same entry is not delivered twice, however often it is polled.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await hub.pollNow(dev);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(seen).toHaveLength(1);
      } finally {
        unsubscribe();
        await hub.stop();
      }
    });
  }, 180_000);

  /**
   * A full page means "there is more behind it", so the hub reads again. What
   * it must not do is read again when the cursor did not move.
   *
   * `settledCursor` only advances past entries older than the settle window,
   * so a large cascade or an emergency stop — every entry brand new — leaves
   * the cursor exactly where it was while the page stays full. Draining on
   * that re-reads the same thousand rows for the whole settle window: 1779
   * pages and 3558 round-trips over 15 s was measured for one developer with
   * a 2500-entry backlog, on the path that has to deliver revocations within
   * two seconds.
   *
   * The backlog here is MAX_PAGE + 1 entries, all unsettled, which is the
   * only shape that reproduces it.
   */
  it('reads a full page of unsettled entries once, instead of spinning on it', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const parent = await grant(dev, 'backlog');
      const rows = Array.from({ length: MAX_PAGE + 1 }, (_, index) => index);
      // Straight into the feed table: a cascade of this size would take
      // minutes to build through the triggers, and the hub cannot tell the
      // difference.
      await sql`
        INSERT INTO grant_revocation_events ${sql(rows.map((index) => ({
          developer_id: dev,
          grant_id: parent,
          jti: `tok_backlog_${index}`,
          action: 'token_revoked',
          cause: 'api',
          expires_at: new Date(Date.now() + 3_600_000),
        })))}`;

      let reads = 0;
      const counting = new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          const text = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
          if (text.includes('FROM grant_revocation_events') && text.includes('ORDER BY seq')) reads += 1;
          return Reflect.apply(target as never, thisArg, args);
        },
        get: (target, property) => Reflect.get(target, property),
      }) as typeof sql;

      const hub = new RevocationFeedHub(counting, log);
      const seen: FeedEntry[] = [];
      const unsubscribe = hub.subscribe(dev, (batch) => { seen.push(...batch.entries); });
      try {
        await hub.pollNow(dev);
        // Whatever the deferred continuation does, give it several turns of
        // the event loop to do it.
        await new Promise((resolve) => setTimeout(resolve, 300));

        // One page delivered, and at most a couple of reads to establish
        // that nothing settled. Before the fix this was 20 reads per poll,
        // re-entered on a zero-delay timer for the whole settle window.
        expect(seen.length).toBe(MAX_PAGE);
        expect(reads).toBeLessThanOrEqual(3);
      } finally {
        unsubscribe();
        await hub.stop();
      }
    });
  }, 180_000);

  /**
   * And the drain still works when the cursor *can* move: once the entries
   * are older than the settle window, a backlog larger than one page is
   * delivered in full rather than a page at a time per interval.
   */
  it('drains a backlog larger than one page in a single poll once entries settle', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const parent = await grant(dev, 'drain');
      const rows = Array.from({ length: MAX_PAGE + 25 }, (_, index) => index);
      await sql`
        INSERT INTO grant_revocation_events ${sql(rows.map((index) => ({
          developer_id: dev,
          grant_id: parent,
          jti: `tok_drain_${index}`,
          action: 'token_revoked',
          cause: 'api',
          expires_at: new Date(Date.now() + 3_600_000),
        })))}`;

      // One second, the shortest the setting allows, so the backlog settles
      // during the test rather than at the end of the default 15 s window.
      vi.stubEnv('REVOCATION_FEED_SETTLE_SECONDS', '1');

      let pages = 0;
      const counting = new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          const text = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
          if (text.includes('FROM grant_revocation_events') && text.includes('ORDER BY seq')) pages += 1;
          return Reflect.apply(target as never, thisArg, args);
        },
        get: (target, property) => Reflect.get(target, property),
      }) as typeof sql;

      const hub = new RevocationFeedHub(counting, log);
      const seen: FeedEntry[] = [];
      const unsubscribe = hub.subscribe(dev, (batch) => { seen.push(...batch.entries); });
      try {
        const deadline = Date.now() + 30_000;
        while (seen.length < MAX_PAGE + 25 && Date.now() < deadline) {
          await hub.pollNow(dev);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(seen.length).toBe(MAX_PAGE + 25);
        // Two pages of entries, a handful of polls that found nothing settled
        // yet, and nothing else. Counting is what makes this test fail if the
        // guard is removed: the unsettled second or so would then be spent
        // re-reading the same page twenty times per poll.
        expect(pages).toBeLessThanOrEqual(30);
      } finally {
        unsubscribe();
        await hub.stop();
        vi.unstubAllEnvs();
      }
    });
  }, 180_000);

  /**
   * A poll that fails halfway must not swallow the entries it had already
   * read.
   *
   * `readSince` succeeded, the entries went into `delivered`, then
   * `settledCursor` threw — so nothing was ever sent, and the next successful
   * poll filtered those same entries out as "already delivered" and could
   * advance the cursor past them. The revocation reached nobody, while the
   * stream's heartbeats kept saying the feed was healthy.
   */
  it('delivers entries that a failed poll had already read', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const id = await grant(dev, 'halfway');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${id}`;

      // The first settled-cursor query belongs to the subscribe-time poll,
      // which runs before anything has been read. The one that matters is the
      // next: after `readSince` has returned the entry.
      let settledCalls = 0;
      const flaky = new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          const text = Array.isArray(args[0]) ? args[0].join('?') : String(args[0]);
          if (text.includes('MAX(seq)') && text.includes('created_at <')) {
            settledCalls += 1;
            if (settledCalls === 2) {
              throw Object.assign(new Error('connection reset'), { code: '08006' });
            }
          }
          return Reflect.apply(target as never, thisArg, args);
        },
        get: (target, property) => Reflect.get(target, property),
      }) as typeof sql;

      const hub = new RevocationFeedHub(flaky, log);
      const seen: FeedEntry[] = [];
      const unsubscribe = hub.subscribe(dev, (batch) => { seen.push(...batch.entries); });
      try {
        // The first poll fails after reading. Before the fix this lost the
        // entry for good.
        await hub.pollNow(dev);
        const deadline = Date.now() + 10_000;
        while (seen.length === 0 && Date.now() < deadline) {
          await hub.pollNow(dev);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(settledCalls).toBeGreaterThan(2); // the failure really happened
        expect(seen.map((entry) => entry.grantId)).toEqual([id]);
      } finally {
        unsubscribe();
        await hub.stop();
      }
    });
  }, 180_000);

  it('records a grant and a token that are deleted, not revoked', async () => {
    await withFixture(async ({ sql, dev, grant, token }) => {
      // What DELETE /v1/agents/:id does: tokens first, then their grants.
      const live = await grant(dev, 'deleted');
      const jti = await token(live, 'deleted');
      const alreadyRevoked = await grant(dev, 'revokedthendeleted');
      // With a live token row, as a cascade leaves it: revoking a grant sets
      // `grants.status` and does not touch `grant_tokens.is_revoked`, because
      // the grant's status is what every authorisation check reads.
      await token(alreadyRevoked, 'revokedthendeleted');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${alreadyRevoked}`;
      const before = await readSince(sql, dev, 0);

      await sql`DELETE FROM grant_tokens WHERE grant_id IN (${live}, ${alreadyRevoked})`;
      await sql`DELETE FROM grants WHERE id IN (${live}, ${alreadyRevoked})`;

      const after = (await readSince(sql, dev, 0)).slice(before.length);
      expect(after.map((entry) => [entry.action, entry.grantId, entry.jti])).toEqual([
        ['token_revoked', live, jti],
        ['revoked', live, null],
      ]);
      // The one already revoked had its entry; deleting the rows is
      // housekeeping. Its *token* used to produce a second entry here,
      // because the sibling trigger only looked at `is_revoked` — so the feed
      // re-inflated with revocations that had already been delivered, while
      // the prune worker was trying to bound it.
      expect(after.some((entry) => entry.grantId === alreadyRevoked)).toBe(false);
    });
  }, 180_000);

  it('never advances the cursor past the page it returned', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const ids: string[] = [];
      for (let index = 0; index < 5; index += 1) ids.push(await grant(dev, `page${index}`));
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ANY(${ids})`;

      // A page smaller than what is settled: the cursor a client adopts must
      // be the last entry it actually received, or the rest are skipped.
      const page = await readSince(sql, dev, 0, 2);
      expect(page).toHaveLength(2);
      const settled = await settledCursor(sql, dev, 0, 0);
      expect(settled).toBeGreaterThan(page[1]!.seq);
      const cursor = Math.min(settled, page[1]!.seq);
      const next = await readSince(sql, dev, cursor, 10);
      expect(next).toHaveLength(3);
      expect(new Set([...page, ...next].map((entry) => entry.grantId)).size).toBe(5);
    });
  }, 180_000);

  it('prunes entries only once the credential is long expired', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      const recent = await grant(dev, 'recent');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${recent}`;
      await sql`
        INSERT INTO grant_revocation_events (developer_id, grant_id, action, expires_at, created_at)
        VALUES (${dev}, 'grnt_ancient', 'revoked', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`;

      expect(await pruneFeedBatch(sql, 48, 1_000)).toBe(1);
      const left = await readSince(sql, dev, 0);
      expect(left.map((entry) => entry.grantId)).toEqual([recent]);

      // And the worker that calls it only runs while the feed is served.
      await sql`
        INSERT INTO grant_revocation_events (developer_id, grant_id, action, expires_at, created_at)
        VALUES (${dev}, 'grnt_ancient_2', 'revoked', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`;
      vi.stubEnv('REVOCATION_FEED_ENABLED', 'false');
      expect(await pruneRevocationFeedOnce(sql, log)).toMatchObject({ outcome: 'disabled', deleted: 0 });
      vi.stubEnv('REVOCATION_FEED_ENABLED', 'true');
      expect(await pruneRevocationFeedOnce(sql, log)).toMatchObject({ outcome: 'complete', deleted: 1 });
      vi.unstubAllEnvs();
    });
  }, 180_000);

  it('prunes a backlog larger than one batch across capped runs, one instance at a time (FINDINGS G-66)', async () => {
    await withFixture(async ({ sql, dev, grant }) => {
      vi.stubEnv('REVOCATION_FEED_ENABLED', 'true');
      vi.stubEnv('REVOCATION_FEED_RETENTION_HOURS', '48');
      // Checked first: the lock key is bound as a query parameter below, and
      // postgres.js stalls rather than failing on an undefined parameter.
      expect(PRUNE_LOCK_KEY).toBe('grantex:revocation-feed-prune');
      const backlog = 750;
      const batchSize = 100;
      const maxBatches = 3;
      await sql`
        INSERT INTO grant_revocation_events (developer_id, grant_id, action, expires_at, created_at)
        SELECT ${dev}, 'grnt_backlog_' || n, 'revoked', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days'
          FROM generate_series(1, ${backlog}) AS n`;
      // Rows inside retention, each kept for a different reason: written
      // recently; written long ago about a credential that is still live; and
      // written long ago about one that expired within the retention window.
      const recent = await grant(dev, 'kept');
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${recent}`;
      await sql`
        INSERT INTO grant_revocation_events (developer_id, grant_id, action, expires_at, created_at) VALUES
          (${dev}, 'grnt_kept_live', 'revoked', NOW() + INTERVAL '30 days', NOW() - INTERVAL '30 days'),
          (${dev}, 'grnt_kept_recently_expired', 'revoked', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '30 days'),
          (${dev}, 'grnt_kept_no_expiry_recent', 'revoked', NULL, NOW() - INTERVAL '1 hour')`;
      const kept = [recent, 'grnt_kept_live', 'grnt_kept_recently_expired', 'grnt_kept_no_expiry_recent'];
      const countBacklog = async () => Number((await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM grant_revocation_events
         WHERE developer_id = ${dev} AND grant_id LIKE 'grnt_backlog_%'`)[0]!.n);

      // Another instance holds the prune lock: this one skips and deletes nothing.
      const other = await sql.reserve();
      try {
        const [held] = await other<{ locked: boolean }[]>`
          SELECT pg_try_advisory_lock(hashtextextended(${PRUNE_LOCK_KEY}, 0)) AS locked`;
        expect(held!.locked).toBe(true);
        const skipped = await pruneRevocationFeedOnce(sql, log, { batchSize, maxBatches });
        expect(skipped).toEqual({ outcome: 'skipped_locked', deleted: 0, batches: 0 });
        expect(await countBacklog()).toBe(backlog);
      } finally {
        await other`SELECT pg_advisory_unlock(hashtextextended(${PRUNE_LOCK_KEY}, 0))`;
        other.release();
      }

      // Two instances start together: exactly one prunes, the other skips.
      const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const together = await Promise.all([
        pruneRevocationFeedOnce(sql, log, { batchSize, maxBatches, sleep: () => slow(200) }),
        pruneRevocationFeedOnce(sql, log, { batchSize, maxBatches, sleep: () => slow(200) }),
      ]);
      expect(together.map((run) => run.outcome).sort()).toEqual(['capped', 'skipped_locked']);
      const first = together.find((run) => run.outcome === 'capped')!;
      // Capped: several bounded statements, not the whole backlog in one.
      expect(first).toEqual({ outcome: 'capped', deleted: batchSize * maxBatches, batches: maxBatches });
      expect(await countBacklog()).toBe(backlog - batchSize * maxBatches);

      // Later runs finish the backlog; the lock was released each time.
      let total = first.deleted;
      let runs = 0;
      for (;;) {
        const run = await pruneRevocationFeedOnce(sql, log, { batchSize, maxBatches, sleep: async () => undefined });
        expect(run.outcome === 'capped' || run.outcome === 'complete').toBe(true);
        total += run.deleted;
        runs += 1;
        if (run.outcome === 'complete') break;
        expect(runs).toBeLessThan(10);
      }
      expect(total).toBe(backlog);
      expect(await countBacklog()).toBe(0);

      const left = await sql<{ grant_id: string }[]>`
        SELECT grant_id FROM grant_revocation_events WHERE developer_id = ${dev} ORDER BY grant_id`;
      expect(left.map((row) => row.grant_id).sort()).toEqual([...kept].sort());
      vi.unstubAllEnvs();
    });
  }, 180_000);
});
