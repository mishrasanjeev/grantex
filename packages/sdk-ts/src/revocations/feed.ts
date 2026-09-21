/**
 * The revocation feed client (PRD G-6).
 *
 * It takes a snapshot of everything currently revoked, then follows the live
 * stream, so `enforce()` can deny a call on a grant that was revoked seconds
 * ago without a network round trip per call.
 *
 * The important part is what happens when it cannot keep up. The feed records
 * when it last heard from the auth service; if that is longer ago than
 * `staleAfterMs`, it reports itself stale and `enforce()` denies rather than
 * allowing calls on information it knows may be out of date.
 */
import type { HttpClient } from '../http.js';
import { RevokedSet, type CredentialRef, type RevocationEntry, type RevocationMatch } from './set.js';

export interface RevocationFeedOptions {
  /**
   * How long the feed may go without hearing from the auth service before it
   * is stale and calls fail closed. Default 5000 ms.
   */
  staleAfterMs?: number;
  /** Delay before reconnecting a dropped stream. Default 500 ms. */
  reconnectDelayMs?: number;
  /** `stream` (Server-Sent Events) or `poll` (long polling). Default `stream`, falling back to `poll`. */
  transport?: 'stream' | 'poll';
}

export type FeedUnavailableReason = 'disabled' | 'not_ready' | 'unauthorized' | 'network';

export interface RevocationFeedState {
  /** A snapshot has been read at least once. */
  synced: boolean;
  /**
   * When the feed last heard from the auth service, on a monotonic clock
   * (0 if never). Comparable with `performance.now()`, not with `Date.now()`.
   */
  freshAt: number;
  /** Feed position of the last entry applied. */
  cursor: number;
  /** Identifiers currently known to be revoked or suspended. */
  known: number;
  /** Why the feed is not usable, if it is not. */
  unavailable: FeedUnavailableReason | null;
}

interface FeedPage {
  entries: RevocationEntry[];
  cursor: number;
  nextPageToken?: string | null;
  snapshot?: boolean;
}

/**
 * Freshness is measured on a monotonic clock: a wall-clock jump backwards
 * must not make a stale feed look current.
 */
const monotonicNow = (): number =>
  (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PRUNE_INTERVAL_MS = 60_000;

export class RevocationFeed {
  readonly #http: HttpClient;
  readonly #set = new RevokedSet();
  readonly #staleAfterMs: number;
  readonly #reconnectDelayMs: number;
  readonly #transport: 'stream' | 'poll';

  #running = false;
  #synced = false;
  #freshAt = 0;
  #cursor = 0;
  #unavailable: FeedUnavailableReason | null = null;
  #controller: AbortController | null = null;
  #loop: Promise<void> | null = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #prunedAt = 0;
  #waiters: Array<() => void> = [];

  constructor(http: HttpClient, options: RevocationFeedOptions = {}) {
    this.#http = http;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#transport = options.transport ?? 'stream';
  }

  get staleAfterMs(): number {
    return this.#staleAfterMs;
  }

  state(): RevocationFeedState {
    return {
      synced: this.#synced,
      freshAt: this.#freshAt,
      cursor: this.#cursor,
      known: this.#set.size,
      unavailable: this.#unavailable,
    };
  }

  /** Synced recently enough to be trusted. */
  isFresh(now: number = monotonicNow()): boolean {
    return this.#synced && this.#unavailable === null && now - this.#freshAt <= this.#staleAfterMs;
  }

  /** Why this credential must not be used, according to what the feed knows. */
  match(ref: CredentialRef, now: number = Date.now()): RevocationMatch | null {
    return this.#set.match(ref, now);
  }

  /** Start following the feed. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#controller = new AbortController();
    this.#loop = this.#run().catch(() => { /* the loop reports through state() */ });
  }

  /** Stop following, and forget what was known (a restarted feed re-reads the snapshot). */
  async stop(): Promise<void> {
    this.#running = false;
    this.#controller?.abort();
    // An open stream is not interrupted by aborting a fetch that already
    // resolved, so release the reader too.
    await this.#reader?.cancel().catch(() => { /* already closed */ });
    const loop = this.#loop;
    this.#loop = null;
    this.#synced = false;
    this.#freshAt = 0;
    this.#set.clear();
    this.#wake();
    if (loop) await loop;
  }

  /**
   * Wait until the feed is fresh, or the timeout passes. Returns whether it is
   * fresh: `false` means callers must fail closed.
   */
  async ready(timeoutMs: number = this.#staleAfterMs): Promise<boolean> {
    this.start();
    const deadline = monotonicNow() + timeoutMs;
    for (;;) {
      if (this.isFresh()) return true;
      if (this.#unavailable !== null || monotonicNow() >= deadline) return this.isFresh();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(50, Math.max(1, deadline - monotonicNow())));
        timer.unref?.();
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter();
  }

  #touch(): void {
    this.#freshAt = monotonicNow();
    // Entries whose credential has expired can no longer be used; dropping
    // them here bounds the set without a timer of its own.
    if (this.#freshAt - this.#prunedAt > PRUNE_INTERVAL_MS) {
      this.#set.prune();
      this.#prunedAt = this.#freshAt;
    }
    this.#unavailable = null;
    this.#wake();
  }

  async #run(): Promise<void> {
    let delay = this.#reconnectDelayMs;
    while (this.#running) {
      try {
        await this.#snapshot();
        delay = this.#reconnectDelayMs;
        if (this.#transport === 'stream') {
          const streamed = await this.#stream();
          if (!streamed) await this.#poll();
          // A stream that ended cleanly (a server restart, a proxy timeout)
          // must not be reconnected in a tight loop.
          else if (this.#running) await sleep(this.#reconnectDelayMs, this.#controller?.signal);
        } else {
          await this.#poll();
        }
      } catch (err) {
        this.#unavailable = classify(err);
        this.#synced = false;
        this.#wake();
        await sleep(delay, this.#controller?.signal);
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
      }
    }
  }

  async #snapshot(): Promise<void> {
    let pageToken: string | null | undefined;
    let cursor = 0;
    // Collected first and swapped in once every page has arrived. A snapshot
    // is the whole truth about what is revoked *now*, so applying it on top
    // of what the set already held kept anything resumed while this client
    // was disconnected — denied until it expired. Swapping only after the
    // last page means a failure part way through leaves the previous set
    // intact rather than a half-built one.
    const entries: RevocationEntry[] = [];
    do {
      // `pageToken` is empty only on the first pass; the loop condition ends
      // it otherwise. The previous null/undefined pair was half redundant,
      // which is what the static analysis was pointing at.
      const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : '';
      const page = await this.#http.get<FeedPage>(`/v1/revocations${query}`);
      entries.push(...page.entries);
      cursor = page.cursor;
      pageToken = page.nextPageToken;
    } while (pageToken);
    this.#set.replaceAll(entries);
    this.#set.prune();
    this.#cursor = cursor;
    this.#synced = true;
    this.#touch();
  }

  /** Follow the Server-Sent Events stream. Returns false if streaming is not usable here. */
  async #stream(): Promise<boolean> {
    const response = await this.#http.rawGet(
      `/v1/revocations/stream?since=${this.#cursor}`,
      this.#controller?.signal,
    );
    if (!response.ok) throw httpError(response.status);
    if (!response.body) return false;

    const reader = response.body.getReader();
    this.#reader = reader;
    const decoder = new TextDecoder();
    let buffer = '';
    // A half-open socket delivers nothing and never ends. Heartbeats are due
    // every second, so silence for twice the staleness bound means the
    // connection is gone: drop it and let the loop reconnect.
    const silenceLimit = Math.max(2 * this.#staleAfterMs, 1_000);
    let watchdog = setTimeout(() => void reader.cancel().catch(() => { /* already closed */ }), silenceLimit);
    watchdog.unref?.();
    try {
      while (this.#running) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => void reader.cancel().catch(() => { /* already closed */ }), silenceLimit);
        watchdog.unref?.();
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf('\n\n');
        while (index !== -1) {
          this.#handleEvent(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\n\n');
        }
      }
    } finally {
      clearTimeout(watchdog);
      this.#reader = null;
      reader.releaseLock();
      await response.body.cancel().catch(() => { /* already closed */ });
    }
    return true;
  }

  #handleEvent(block: string): void {
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event === 'heartbeat' || event === 'ready') {
      this.#touch();
      return;
    }
    if (event !== 'revocation' || data.length === 0) return;
    try {
      const entry = JSON.parse(data) as RevocationEntry;
      this.#set.apply(entry);
      if (entry.seq > this.#cursor) this.#cursor = entry.seq;
      this.#touch();
    } catch {
      // A line we cannot read is not evidence that nothing is revoked; the
      // next heartbeat decides freshness.
    }
  }

  /** Long-poll fallback for runtimes without streaming response bodies. */
  async #poll(): Promise<void> {
    const wait = Math.max(1, Math.floor(this.#staleAfterMs / 2 / 1000));
    while (this.#running) {
      const page = await this.#http.get<FeedPage>(`/v1/revocations?since=${this.#cursor}&wait=${wait}`);
      this.#set.applyAll(page.entries);
      if (page.cursor > this.#cursor) this.#cursor = page.cursor;
      for (const entry of page.entries) if (entry.seq > this.#cursor) this.#cursor = entry.seq;
      this.#touch();
    }
  }
}

function httpError(status: number): Error {
  const error = new Error(`revocation feed responded ${status}`);
  (error as Error & { status?: number }).status = status;
  return error;
}

function classify(err: unknown): FeedUnavailableReason {
  const status = (err as { status?: number; statusCode?: number } | null)?.statusCode
    ?? (err as { status?: number } | null)?.status;
  if (status === 404) return 'disabled';
  if (status === 503) return 'not_ready';
  if (status === 401 || status === 403) return 'unauthorized';
  return 'network';
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
