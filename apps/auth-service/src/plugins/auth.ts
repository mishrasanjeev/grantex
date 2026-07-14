import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getSql } from '../db/client.js';
import { hashApiKey } from '../lib/hash.js';
import { isPlanName, type PlanName } from '../lib/plans.js';

export interface Developer {
  id: string;
  name: string;
  mode: 'live' | 'sandbox';
  plan: PlanName;
}

declare module 'fastify' {
  interface FastifyRequest {
    developer: Developer;
  }

  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];
  const match = typeof authHeader === 'string'
    ? /^Bearer[ \t]+([^\s]+)$/i.exec(authHeader)
    : null;
  if (!match) {
    await reply.status(401).send({
      message: 'Missing or invalid Authorization header',
      code: 'UNAUTHORIZED',
      requestId: request.id,
    });
    return;
  }

  const apiKey = match[1]!;
  if (apiKey.length < 16 || apiKey.length > 512) {
    await reply.status(401).send({
      message: 'Invalid API key',
      code: 'UNAUTHORIZED',
      requestId: request.id,
    });
    return;
  }
  const keyHash = hashApiKey(apiKey);

  const sql = getSql();
  const rows = await sql<{ id: string; name: string; mode: string; plan: string }[]>`
    SELECT d.id, d.name, d.mode,
           COALESCE((
             SELECT s.plan
             FROM subscriptions s
             WHERE s.developer_id = d.id
             LIMIT 1
           ), 'free') AS plan
    FROM developers d
    WHERE d.api_key_hash = ${keyHash}
    LIMIT 1
  `;

  const dev = rows[0];
  if (!dev) {
    await reply.status(401).send({
      message: 'Invalid API key',
      code: 'UNAUTHORIZED',
      requestId: request.id,
    });
    return;
  }

  request.developer = {
    id: dev.id,
    name: dev.name,
    mode: dev.mode === 'sandbox' ? 'sandbox' : 'live',
    plan: isPlanName(dev.plan) ? dev.plan : 'free',
  };
}

export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/.well-known/')) return;
    if (request.url.startsWith('/scim/')) return;  // SCIM uses its own bearer token auth
    if (request.routeOptions.config.skipAuth) return;
    await authenticateRequest(request, reply);
  });
}
