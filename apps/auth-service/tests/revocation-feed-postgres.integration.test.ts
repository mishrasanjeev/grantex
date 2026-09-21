import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { RevocationFeedHub } from '../src/lib/revocation-feed/hub.js';
import { pruneRevocationFeedOnce } from '../src/workers/revocationFeedPrune.js';
import {
  feedReady,
  headSeq,
  pruneFeed,
  readSince,
  resetFeedReadyCache,
  revocationStatus,
  settledCursor,
  snapshotPage,
  type FeedEntry,
} from '../src/lib/revocation-feed/store.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres revocation feed tests',
  );
}
const describePostgres = databaseUrl ? describe : describe.skip;

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
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW() WHERE id = ${alreadyRevoked}`;
      const before = await readSince(sql, dev, 0);

      await sql`DELETE FROM grant_tokens WHERE grant_id IN (${live}, ${alreadyRevoked})`;
      await sql`DELETE FROM grants WHERE id IN (${live}, ${alreadyRevoked})`;

      const after = (await readSince(sql, dev, 0)).slice(before.length);
      expect(after.map((entry) => [entry.action, entry.grantId, entry.jti])).toEqual([
        ['token_revoked', live, jti],
        ['revoked', live, null],
      ]);
      // The one already revoked had its entry; deleting the row is housekeeping.
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

      expect(await pruneFeed(sql, 48)).toBe(1);
      const left = await readSince(sql, dev, 0);
      expect(left.map((entry) => entry.grantId)).toEqual([recent]);

      // And the worker that calls it only runs while the feed is served.
      await sql`
        INSERT INTO grant_revocation_events (developer_id, grant_id, action, expires_at, created_at)
        VALUES (${dev}, 'grnt_ancient_2', 'revoked', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`;
      vi.stubEnv('REVOCATION_FEED_ENABLED', 'false');
      expect(await pruneRevocationFeedOnce(sql, log)).toBe(0);
      vi.stubEnv('REVOCATION_FEED_ENABLED', 'true');
      expect(await pruneRevocationFeedOnce(sql, log)).toBe(1);
      vi.unstubAllEnvs();
    });
  }, 180_000);
});
