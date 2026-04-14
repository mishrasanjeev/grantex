import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { getRedis } from '../redis/client.js';

const MAX_CONNECTIONS_PER_DEV = 5;
const KEEPALIVE_INTERVAL_MS = 30_000;
const CONN_COUNTER_TTL_SECONDS = 300;

/**
 * SSE + WebSocket event streaming routes.
 * Subscribes to Redis pub/sub channel `grantex:events:{developerId}`
 * and forwards events to connected clients.
 */
export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/events/stream — Server-Sent Events
  app.get('/v1/events/stream', async (request, reply) => {
    const developerId = request.developer.id;
    const typesParam = (request.query as Record<string, string>)['types'];
    const filterTypes = typesParam ? typesParam.split(',') : null;

    const redis = getRedis();
    const connKey = `sse:connections:${developerId}`;
    const connCount = await redis.incr(connKey);
    await redis.expire(connKey, CONN_COUNTER_TTL_SECONDS);

    if (connCount > MAX_CONNECTIONS_PER_DEV) {
      await safeDecr(redis, connKey);
      return reply.status(429).send({
        message: `Max ${MAX_CONNECTIONS_PER_DEV} concurrent SSE connections per developer`,
        code: 'TOO_MANY_CONNECTIONS',
        requestId: request.id,
      });
    }

    reply.hijack();

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const subscriber = redis.duplicate();
    await subscriber.connect();

    const channel = `grantex:events:${developerId}`;
    await subscriber.subscribe(channel);

    subscriber.on('message', (_ch: string, message: string) => {
      if (filterTypes) {
        try {
          const parsed = JSON.parse(message) as { type?: string };
          if (parsed.type && !filterTypes.includes(parsed.type)) return;
        } catch { /* forward unparseable messages */ }
      }
      reply.raw.write(`data: ${message}\n\n`);
    });

    const keepalive = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
      redis.expire(connKey, CONN_COUNTER_TTL_SECONDS).catch(() => { /* transient — next tick refreshes */ });
    }, KEEPALIVE_INTERVAL_MS);

    request.raw.on('close', async () => {
      clearInterval(keepalive);
      await subscriber.unsubscribe(channel);
      subscriber.disconnect();
      await safeDecr(redis, connKey);
    });
  });

  // GET /v1/events/ws — WebSocket
  app.get('/v1/events/ws', { websocket: true }, async (socket, request) => {
    const developerId = request.developer.id;

    const redis = getRedis();
    const connKey = `ws:connections:${developerId}`;
    const connCount = await redis.incr(connKey);
    await redis.expire(connKey, CONN_COUNTER_TTL_SECONDS);

    if (connCount > MAX_CONNECTIONS_PER_DEV) {
      await safeDecr(redis, connKey);
      socket.close(1013, 'Too many connections');
      return;
    }

    let filterTypes: string[] | null = null;

    const subscriber = redis.duplicate();
    await subscriber.connect();

    const channel = `grantex:events:${developerId}`;
    await subscriber.subscribe(channel);

    subscriber.on('message', (_ch: string, message: string) => {
      if (filterTypes) {
        try {
          const parsed = JSON.parse(message) as { type?: string };
          if (parsed.type && !filterTypes.includes(parsed.type)) return;
        } catch { /* forward unparseable messages */ }
      }
      socket.send(message);
    });

    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as { types?: string[] };
        if (msg.types) {
          filterTypes = msg.types;
        }
      } catch { /* ignore invalid messages */ }
    });

    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.ping();
        redis.expire(connKey, CONN_COUNTER_TTL_SECONDS).catch(() => { /* transient — next tick refreshes */ });
      }
    }, KEEPALIVE_INTERVAL_MS);

    socket.on('close', async () => {
      clearInterval(pingInterval);
      await subscriber.unsubscribe(channel);
      subscriber.disconnect();
      await safeDecr(redis, connKey);
    });
  });
}

// DECR then clamp at 0 so transient counter drift (e.g. the key expired
// while long-lived clients were still connected) cannot drive the gauge
// negative and silently grant unlimited future connections.
const SAFE_DECR_SCRIPT = `
  local v = redis.call('DECR', KEYS[1])
  if v < 0 then
    redis.call('SET', KEYS[1], 0)
    return 0
  end
  return v
`;

async function safeDecr(redis: Redis, key: string): Promise<void> {
  try {
    await redis.eval(SAFE_DECR_SCRIPT, 1, key);
  } catch {
    // If the Lua call fails (e.g. redis temporarily unavailable),
    // fall back to a plain DECR. The subsequent keepalive tick will
    // restore the TTL and next connection's INCR will self-correct.
    await redis.decr(key).catch(() => { /* swallow */ });
  }
}
