import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newDeveloperId } from '../lib/ids.js';
import { hashApiKey, generateApiKey } from '../lib/hash.js';

interface SignupBody {
  name: string;
  email?: string;
  mode?: 'live' | 'sandbox';
}

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/signup — create a new developer account (public)
  app.post<{ Body: SignupBody }>(
    '/v1/signup',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<SignupBody>;
      const { name, mode: requestedMode } = body;
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
        return reply.status(400).send({ message: 'name must be 1 to 200 characters', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (requestedMode !== undefined && requestedMode !== 'live' && requestedMode !== 'sandbox') {
        return reply.status(400).send({ message: 'mode must be live or sandbox', code: 'BAD_REQUEST', requestId: request.id });
      }
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email;
      if (email !== undefined && (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
        return reply.status(400).send({ message: 'email must be a valid address', code: 'BAD_REQUEST', requestId: request.id });
      }

      const mode = requestedMode === 'sandbox' ? 'sandbox' : 'live';

      const sql = getSql();

      if (email) {
        const existing = await sql`SELECT id FROM developers WHERE LOWER(email) = ${email} LIMIT 1`;
        if (existing.length > 0) {
          return reply.status(409).send({ message: 'A developer with this email already exists', code: 'CONFLICT', requestId: request.id });
        }
      }

      const id = newDeveloperId();
      const apiKey = generateApiKey(mode);
      const keyHash = hashApiKey(apiKey);

      let rows;
      try {
        rows = await sql`
          INSERT INTO developers (id, name, email, api_key_hash, mode)
          VALUES (${id}, ${name.trim()}, ${email ?? null}, ${keyHash}, ${mode})
          RETURNING id, name, email, mode, created_at
        `;
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          return reply.status(409).send({ message: 'A developer with this email already exists', code: 'CONFLICT', requestId: request.id });
        }
        throw error;
      }

      return reply.status(201).send({
        developerId: rows[0]!['id'],
        apiKey,
        name: rows[0]!['name'],
        email: rows[0]!['email'] ?? null,
        mode: rows[0]!['mode'],
        createdAt: rows[0]!['created_at'],
      });
    },
  );

  // POST /v1/keys/rotate — rotate API key (authenticated)
  app.post('/v1/keys/rotate', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const sql = getSql();
    const developerId = request.developer.id;
    const mode = request.developer.mode;

    const apiKey = generateApiKey(mode);
    const keyHash = hashApiKey(apiKey);

    await sql`
      UPDATE developers SET api_key_hash = ${keyHash} WHERE id = ${developerId}
    `;

    return reply.send({
      apiKey,
      rotatedAt: new Date().toISOString(),
    });
  });
}
