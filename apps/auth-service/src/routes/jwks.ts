import type { FastifyInstance } from 'fastify';
import { buildJwks } from '../lib/crypto.js';

export async function jwksRoutes(app: FastifyInstance): Promise<void> {
  app.get('/.well-known/jwks.json', async (_request, reply) => {
    const jwks = await buildJwks();
    await reply.send(jwks);
  });
}
