/**
 * The in-process fan-out behind the live revocation feed.
 *
 * One poller per developer that has subscribers on this instance reads new
 * entries and hands them to every stream. Postgres `LISTEN` wakes it the
 * moment a revocation commits (the notification is delivered on commit, so it
 * never announces a revocation that was rolled back); the periodic poll is the
 * safety net, so a lost notification costs latency and never correctness.
 *
 * Freshness is explicit. Every batch carries the time of the last successful
 * read, and a stream only says "up to date" while that read is recent. A
 * client that stops hearing from the feed must fail closed — the whole point
 * of the feed is that `enforce()` cannot see revocations on its own.
 */
import type postgres from 'postgres';
import { logger, type AppLogger } from '../logger.js';
import {
  revocationFeedDeliverySeconds,
  revocationFeedEntriesTotal,
  revocationFeedPollsTotal,
  revocationFeedStaleSeconds,
  revocationFeedSubscribers,
} from './metrics.js';
import { MAX_PAGE, readSince, settledCursor, type FeedEntry } from './store.js';
import { revocationFeedSettings, type RevocationFeedSettings } from './settings.js';

type Sql = ReturnType<typeof postgres>;

export const REVOCATION_CHANNEL = 'grantex_revocation';

export interface FeedBatch {
  entries: FeedEntry[];
  /** Everything up to this sequence number has been delivered and settled. */
  cursor: number;
  /** When the feed last read the database successfully. */
  freshAt: number;
}

export type FeedSubscriber = (batch: FeedBatch) => void;

interface DeveloperFeed {
  subscribers: Set<FeedSubscriber>;
  cursor: number;
  delivered: Set<number>;
  timer: NodeJS.Timeout | null;
  polling: boolean;
  freshAt: number;
}

export class RevocationFeedHub {
  readonly #sql: Sql;
  readonly #log: AppLogger;
  readonly #feeds = new Map<string, DeveloperFeed>();
  #listener: { unlisten: () => Promise<void> } | null = null;
  #listening = false;

  constructor(sql: Sql, log: AppLogger = logger) {
    this.#sql = sql;
    this.#log = log;
  }

  #settings(): RevocationFeedSettings {
    return revocationFeedSettings();
  }

  /**
   * Watch one developer's revocations. `onBatch` is called with new entries and
   * with freshness updates; unsubscribe with the returned function.
   */
  subscribe(developerId: string, onBatch: FeedSubscriber): () => void {
    let feed = this.#feeds.get(developerId);
    if (!feed) {
      feed = { subscribers: new Set(), cursor: 0, delivered: new Set(), timer: null, polling: false, freshAt: 0 };
      this.#feeds.set(developerId, feed);
      // Start from the present: a joining stream replays its own history from
      // the database, so the hub only has to carry what happens from now on.
      void this.#poll(developerId, true);
      feed.timer = setInterval(() => void this.#poll(developerId), this.#settings().pollMs);
      feed.timer.unref?.();
    }
    feed.subscribers.add(onBatch);
    revocationFeedSubscribers.inc();
    void this.#startListening();

    return () => {
      const current = this.#feeds.get(developerId);
      if (!current || !current.subscribers.delete(onBatch)) return;
      revocationFeedSubscribers.dec();
      if (current.subscribers.size === 0) {
        if (current.timer) clearInterval(current.timer);
        this.#feeds.delete(developerId);
      }
    };
  }

  /** The feed position a joining stream should replay from. */
  cursorOf(developerId: string): number {
    return this.#feeds.get(developerId)?.cursor ?? 0;
  }

  /** When this developer's feed last read the database successfully. */
  freshAt(developerId: string): number {
    return this.#feeds.get(developerId)?.freshAt ?? 0;
  }

  /** Read now rather than at the next tick (used by the notification listener and by tests). */
  async pollNow(developerId: string): Promise<void> {
    await this.#poll(developerId);
  }

  async stop(): Promise<void> {
    for (const [developerId, feed] of this.#feeds) {
      if (feed.timer) clearInterval(feed.timer);
      revocationFeedSubscribers.dec(feed.subscribers.size);
      this.#feeds.delete(developerId);
    }
    if (this.#listener) {
      await this.#listener.unlisten().catch(() => { /* shutting down */ });
      this.#listener = null;
    }
    this.#listening = false;
  }

  async #startListening(): Promise<void> {
    if (this.#listening) return;
    this.#listening = true;
    try {
      this.#listener = await this.#sql.listen(REVOCATION_CHANNEL, (payload: string) => {
        if (this.#feeds.has(payload)) void this.#poll(payload);
      });
    } catch (err) {
      // Without notifications the poll interval still delivers everything.
      this.#listening = false;
      this.#log.warn({ err, feed: 'revocation' }, 'revocation feed could not listen for notifications; polling only');
    }
  }

  async #poll(developerId: string, initial = false): Promise<void> {
    const feed = this.#feeds.get(developerId);
    if (!feed || feed.polling) return;
    feed.polling = true;
    const settings = this.#settings();
    try {
      if (initial) {
        // Start settled: entries older than the settle window are already
        // delivered by the joining stream's own replay.
        feed.cursor = await settledCursor(this.#sql, developerId, 0, settings.settleSeconds);
      }
      const entries = await readSince(this.#sql, developerId, feed.cursor, MAX_PAGE);
      const fresh = entries.filter((entry) => !feed.delivered.has(entry.seq));
      feed.freshAt = Date.now();
      revocationFeedPollsTotal.inc({ outcome: 'ok' });
      revocationFeedStaleSeconds.set(0);

      if (fresh.length > 0) {
        for (const entry of fresh) {
          feed.delivered.add(entry.seq);
          revocationFeedEntriesTotal.inc({ action: entry.action });
          revocationFeedDeliverySeconds.observe(Math.max(0, (Date.now() - new Date(entry.at).getTime()) / 1000));
        }
      }
      // The cursor may never run ahead of what was read: a page is bounded by
      // MAX_PAGE, the settled maximum is not, and advancing past the gap would
      // silently skip every entry in it — exactly what a large cascade or an
      // emergency stop produces.
      const settled = await settledCursor(this.#sql, developerId, feed.cursor, settings.settleSeconds);
      const highestRead = entries.reduce((highest, entry) => Math.max(highest, entry.seq), feed.cursor);
      const advanceTo = entries.length >= MAX_PAGE ? Math.min(settled, highestRead) : settled;
      if (advanceTo > feed.cursor) {
        feed.cursor = advanceTo;
        for (const seq of feed.delivered) if (seq <= advanceTo) feed.delivered.delete(seq);
      }
      const more = entries.length >= MAX_PAGE;
      const batch: FeedBatch = { entries: fresh, cursor: feed.cursor, freshAt: feed.freshAt };
      for (const subscriber of feed.subscribers) {
        try {
          subscriber(batch);
        } catch (err) {
          this.#log.warn({ err, feed: 'revocation' }, 'a revocation feed subscriber threw');
        }
      }
      if (more) {
        // A full page means there is more behind it; keep reading rather than
        // waiting for the next tick.
        feed.polling = false;
        await this.#poll(developerId);
        return;
      }
    } catch (err) {
      revocationFeedPollsTotal.inc({ outcome: 'error' });
      revocationFeedStaleSeconds.set(feed.freshAt === 0 ? 0 : (Date.now() - feed.freshAt) / 1000);
      // Deliberately no re-delivery and no freshness update: streams stop
      // confirming they are up to date and their clients fail closed.
      this.#log.error({ err, feed: 'revocation', developerId }, 'revocation feed poll failed');
    } finally {
      feed.polling = false;
    }
  }
}

let hub: RevocationFeedHub | null = null;

/** The instance-wide hub, created on first use. */
export function getRevocationFeedHub(sql: Sql, log?: AppLogger): RevocationFeedHub {
  if (!hub) hub = new RevocationFeedHub(sql, log);
  return hub;
}

/** For tests: drop the hub so the next call builds a new one. */
export async function resetRevocationFeedHub(): Promise<void> {
  if (hub) await hub.stop();
  hub = null;
}
