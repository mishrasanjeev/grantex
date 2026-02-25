import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
} from 'fastify';
import { getSql } from '../db/client.js';
import { hashApiKey } from '../lib/hash.js';

export interface Developer {
  id: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    developer: Developer;
  }
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    await reply.status(401).send({
      message: 'Missing or invalid Authorization header',
      code: 'UNAUTHORIZED',
      requestId: request.id,
    });
    return;
  }

  const apiKey = authHeader.slice(7);
  const keyHash = hashApiKey(apiKey);

  const sql = getSql();
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM developers WHERE api_key_hash = ${keyHash} LIMIT 1
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

  request.developer = { id: dev.id, name: dev.name };
}

export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/.well-known/')) return;
    await authenticateRequest(request, reply);
  });
}
