/**
 * The revocation feed (PRD G-6). `enforce()` verifies a grant token offline
 * and cannot see a revocation; these endpoints are how an SDK finds out, and
 * how it knows when it can no longer trust what it knows.
 *
 *   GET /v1/revocations                 snapshot (no `since`) or changes since a cursor,
 *                                       optionally long-polling with `wait`
 *   GET /v1/revocations/status          one credential, for online checks
 *   GET /v1/revocations/stream          live Server-Sent Events with heartbeats
 *
 * Off unless REVOCATION_FEED_ENABLED=true, when every route answers 404. When
 * the feed cannot be trusted — the triggers that fill it are missing — the
 * endpoints answer 503 rather than a feed that might miss a revocation.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { getRevocationFeedHub, resetRevocationFeedHub, type FeedBatch } from '../lib/revocation-feed/hub.js';
import { revocationFeedEnabledFor, revocationFeedSettings } from '../lib/revocation-feed/settings.js';
import {
  feedReady,
  readSince,
  revocationStatus,
  settledCursor,
  snapshotPage,
  MAX_PAGE,
  type FeedEntry,
} from '../lib/revocation-feed/store.js';

const MAX_WAIT_SECONDS = 25;
const streamsPerDeveloper = new Map<string, number>();

interface FeedQuery {
  since?: string;
  pageToken?: string;
  limit?: string;
  wait?: string;
}

interface StatusQuery {
  grantId?: string;
  jti?: string;
}

function notFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.status(404).send({ message: 'Not found', code: 'NOT_FOUND', requestId: request.id });
}

function badRequest(request: FastifyRequest, reply: FastifyReply, message: string): FastifyReply {
  return reply.status(400).send({ message, code: 'BAD_REQUEST', requestId: request.id });
}

function unavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply.status(503).send({
    message: 'The revocation feed is not ready on this deployment; do not treat its absence as "nothing is revoked"',
    code: 'FEED_UNAVAILABLE',
    requestId: request.id,
  });
}

function integerParam(value: string | undefined, name: string, min: number, max: number): number | null {
  if (value === undefined) return null;
  if (!/^\d{1,18}$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

export async function revocationRoutes(app: FastifyInstance): Promise<void> {
  // The hub owns timers and a LISTEN connection; a closed server must not
  // leave them running (tests build and close many servers).
  app.addHook('onClose', async () => {
    streamsPerDeveloper.clear();
    await resetRevocationFeedHub();
  });

  app.get<{ Querystring: FeedQuery }>(
    '/v1/revocations',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = revocationFeedSettings();
      if (!revocationFeedEnabledFor(settings, request.developer.id)) return notFound(request, reply);
      const sql = getSql();
      if (!await feedReady(sql)) return unavailable(request, reply);

      let since: number | null;
      let limit: number | null;
      let wait: number | null;
      try {
        since = integerParam(request.query.since, 'since', 0, Number.MAX_SAFE_INTEGER);
        limit = integerParam(request.query.limit, 'limit', 1, MAX_PAGE);
        wait = integerParam(request.query.wait, 'wait', 0, MAX_WAIT_SECONDS);
      } catch (err) {
        return badRequest(request, reply, err instanceof Error ? err.message : 'invalid query');
      }

      const developerId = request.developer.id;
      reply.header('Cache-Control', 'private, max-age=1');

      if (since === null) {
        // A client starting cold: everything currently revoked or suspended,
        // plus the position to stream from. Read the cursor first, so nothing
        // that happens while paging can fall between the two.
        const cursor = await settledCursor(sql, developerId, 0, settings.settleSeconds);
        let page;
        try {
          page = await snapshotPage(sql, developerId, request.query.pageToken, limit ?? MAX_PAGE);
        } catch (err) {
          return badRequest(request, reply, err instanceof Error ? err.message : 'invalid pageToken');
        }
        return reply.send({
          entries: page.entries,
          nextPageToken: page.nextPageToken,
          cursor,
          snapshot: true,
          serverTime: new Date().toISOString(),
        });
      }

      let entries = await readSince(sql, developerId, since, limit ?? MAX_PAGE);
      if (entries.length === 0 && wait !== null && wait > 0) {
        entries = await waitForEntries(developerId, since, wait);
      }
      // The cursor may never run ahead of what this response carried: a page
      // is bounded by `limit`, the settled maximum is not, and a client that
      // adopted the larger number would skip everything in between and still
      // believe itself up to date.
      const settled = await settledCursor(sql, developerId, since, settings.settleSeconds);
      const delivered = entries.reduce((highest, entry) => Math.max(highest, entry.seq), since);
      const cursor = entries.length > 0 ? Math.min(settled, delivered) : settled;

      const etag = `W/"r${cursor}-${entries.length}"`;
      if (entries.length === 0 && request.headers['if-none-match'] === etag) {
        reply.header('ETag', etag);
        return reply.status(304).send();
      }
      reply.header('ETag', etag);
      return reply.send({
        entries,
        cursor,
        snapshot: false,
        serverTime: new Date().toISOString(),
      });
    },
  );

  app.get<{ Querystring: StatusQuery }>(
    '/v1/revocations/status',
    { config: { rateLimit: { max: 1_200, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = revocationFeedSettings();
      if (!revocationFeedEnabledFor(settings, request.developer.id)) return notFound(request, reply);
      const grantId = typeof request.query.grantId === 'string' ? request.query.grantId : null;
      const jti = typeof request.query.jti === 'string' ? request.query.jti : null;
      if (grantId === null && jti === null) {
        return badRequest(request, reply, 'grantId or jti is required');
      }
      if ((grantId !== null && grantId.length > 256) || (jti !== null && jti.length > 512)) {
        return badRequest(request, reply, 'grantId and jti must be short identifiers');
      }

      const status = await revocationStatus(getSql(), request.developer.id, grantId, jti);
      const etag = `W/"s${status.status}-${status.expiresAt ?? ''}"`;
      reply.header('Cache-Control', 'private, max-age=1');
      reply.header('ETag', etag);
      if (request.headers['if-none-match'] === etag) return reply.status(304).send();
      return reply.send({ ...status, checkedAt: new Date().toISOString() });
    },
  );

  // Live feed. Hijacked like /v1/events/stream, so it is exercised by the
  // integration and release tests rather than by inject().
  app.get<{ Querystring: { since?: string } }>(
    '/v1/revocations/stream',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const settings = revocationFeedSettings();
      if (!revocationFeedEnabledFor(settings, request.developer.id)) return notFound(request, reply);
      const sql = getSql();
      if (!await feedReady(sql)) return unavailable(request, reply);

      let since: number | null;
      try {
        since = integerParam(request.query.since, 'since', 0, Number.MAX_SAFE_INTEGER);
      } catch (err) {
        return badRequest(request, reply, err instanceof Error ? err.message : 'invalid query');
      }

      const developerId = request.developer.id;
      const open = streamsPerDeveloper.get(developerId) ?? 0;
      if (open >= settings.maxConnections) {
        return reply.status(429).send({
          message: `At most ${settings.maxConnections} revocation streams per developer on one instance`,
          code: 'TOO_MANY_CONNECTIONS',
          requestId: request.id,
        });
      }
      streamsPerDeveloper.set(developerId, open + 1);

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let cursor = since ?? 0;
      const buffered: FeedEntry[] = [];
      let replayed = false;
      const write = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const send = (entries: FeedEntry[]): void => {
        for (const entry of entries) {
          if (entry.seq > cursor) cursor = entry.seq;
          write('revocation', entry);
        }
      };

      // The hub outlives this request, so it keeps the service logger rather
      // than a request-scoped child.
      const hub = getRevocationFeedHub(sql);
      const unsubscribe = hub.subscribe(developerId, (batch: FeedBatch) => {
        if (!replayed) {
          buffered.push(...batch.entries);
          return;
        }
        send(batch.entries);
      });

      try {
        // Replay this stream's own history, then flush anything the hub
        // delivered while we were reading it (duplicates are harmless: the
        // client keeps a set of revoked identifiers).
        let from = since ?? 0;
        for (;;) {
          const page = await readSince(sql, developerId, from, MAX_PAGE);
          if (page.length === 0) break;
          send(page);
          from = page[page.length - 1]!.seq;
          if (page.length < MAX_PAGE) break;
        }
        replayed = true;
        send(buffered.splice(0));
        write('ready', { cursor, serverTime: new Date().toISOString() });
      } catch (err) {
        request.log.error({ err, feed: 'revocation' }, 'revocation stream could not replay');
        unsubscribe();
        streamsPerDeveloper.set(developerId, (streamsPerDeveloper.get(developerId) ?? 1) - 1);
        reply.raw.end();
        return reply;
      }

      // A heartbeat says "the feed read the database this recently". It stops
      // when the feed cannot read, which is what makes a client fail closed.
      const staleAfter = settings.pollMs * 2 + 1_000;
      const heartbeat = setInterval(() => {
        const freshAt = hub.freshAt(developerId);
        if (freshAt > 0 && Date.now() - freshAt <= staleAfter) {
          write('heartbeat', { cursor, freshAt: new Date(freshAt).toISOString() });
        }
      }, settings.heartbeatMs);
      heartbeat.unref?.();

      let closed = false;
      const close = (): void => {
        // `close` and `error` can both fire for one connection; without this
        // the per-developer counter drifts down and the cap stops meaning
        // anything.
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        const count = (streamsPerDeveloper.get(developerId) ?? 1) - 1;
        if (count <= 0) streamsPerDeveloper.delete(developerId);
        else streamsPerDeveloper.set(developerId, count);
      };
      request.raw.on('close', close);
      request.raw.on('error', close);
      return reply;
    },
  );
}

async function waitForEntries(developerId: string, since: number, waitSeconds: number): Promise<FeedEntry[]> {
  const hub = getRevocationFeedHub(getSql());
  return new Promise<FeedEntry[]>((resolve) => {
    let settled = false;
    const finish = (entries: FeedEntry[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(entries);
    };
    const unsubscribe = hub.subscribe(developerId, (batch) => {
      const fresh = batch.entries.filter((entry) => entry.seq > since);
      if (fresh.length > 0) finish(fresh);
    });
    const timer = setTimeout(() => finish([]), waitSeconds * 1_000);
    timer.unref?.();
  });
}
