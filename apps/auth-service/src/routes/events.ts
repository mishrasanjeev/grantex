import type { FastifyInstance } from 'fastify';
import { getRedis } from '../redis/client.js';
import { Redis } from 'ioredis';

const MAX_CONNECTIONS_PER_DEV = 5;
const KEEPALIVE_INTERVAL_MS = 30_000;

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

    // Enforce connection limit
    const redis = getRedis();
    const connKey = `sse:connections:${developerId}`;
    const connCount = await redis.incr(connKey);
    await redis.expire(connKey, 300); // 5 min TTL as safety net

    if (connCount > MAX_CONNECTIONS_PER_DEV) {
      await redis.decr(connKey);
      return reply.status(429).send({
        message: `Max ${MAX_CONNECTIONS_PER_DEV} concurrent SSE connections per developer`,
        code: 'TOO_MANY_CONNECTIONS',
        requestId: request.id,
      });
    }

    // Hijack the response so Fastify doesn't manage it
    reply.hijack();

    // Set SSE headers
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // Create a dedicated Redis subscriber
    const redisConfig = (redis as unknown as { options: { host: string; port: number } }).options;
    const subscriber = new Redis({ host: redisConfig?.host ?? 'localhost', port: redisConfig?.port ?? 6379, lazyConnect: true });
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

    // Keepalive
    const keepalive = setInterval(() => {
      reply.raw.write(': keepalive\n\n');
    }, KEEPALIVE_INTERVAL_MS);

    // Cleanup on disconnect
    request.raw.on('close', async () => {
      clearInterval(keepalive);
      await subscriber.unsubscribe(channel);
      subscriber.disconnect();
      await redis.decr(connKey);
    });
  });

  // GET /v1/events/ws — WebSocket
  app.get('/v1/events/ws', { websocket: true }, async (socket, request) => {
    const developerId = request.developer.id;

    // Enforce connection limit
    const redis = getRedis();
    const connKey = `ws:connections:${developerId}`;
    const connCount = await redis.incr(connKey);
    await redis.expire(connKey, 300);

    if (connCount > MAX_CONNECTIONS_PER_DEV) {
      await redis.decr(connKey);
      socket.close(1013, 'Too many connections');
      return;
    }

    let filterTypes: string[] | null = null;

    // Create a dedicated Redis subscriber
    const redisConfig = (redis as unknown as { options: { host: string; port: number } }).options;
    const subscriber = new Redis({ host: redisConfig?.host ?? 'localhost', port: redisConfig?.port ?? 6379, lazyConnect: true });
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

    // Accept filter configuration via client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as { types?: string[] };
        if (msg.types) {
          filterTypes = msg.types;
        }
      } catch { /* ignore invalid messages */ }
    });

    // Ping/pong keepalive
    const pingInterval = setInterval(() => {
      if (socket.readyState === 1) {
        socket.ping();
      }
    }, KEEPALIVE_INTERVAL_MS);

    socket.on('close', async () => {
      clearInterval(pingInterval);
      await subscriber.unsubscribe(channel);
      subscriber.disconnect();
      await redis.decr(connKey);
    });
  });
}
