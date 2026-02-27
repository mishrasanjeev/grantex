import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newDeveloperId } from '../lib/ids.js';
import { hashApiKey, generateApiKey } from '../lib/hash.js';

interface SignupBody {
  name: string;
  email?: string;
}

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/signup — create a new developer account (public)
  app.post<{ Body: SignupBody }>(
    '/v1/signup',
    { config: { skipAuth: true } },
    async (request, reply) => {
      const { name, email } = request.body;
      if (!name) {
        return reply.status(400).send({ message: 'name is required', code: 'BAD_REQUEST', requestId: request.id });
      }

      const sql = getSql();

      if (email) {
        const existing = await sql`SELECT id FROM developers WHERE email = ${email} LIMIT 1`;
        if (existing.length > 0) {
          return reply.status(409).send({ message: 'A developer with this email already exists', code: 'CONFLICT', requestId: request.id });
        }
      }

      const id = newDeveloperId();
      const apiKey = generateApiKey();
      const keyHash = hashApiKey(apiKey);

      const rows = await sql`
        INSERT INTO developers (id, name, email, api_key_hash, mode)
        VALUES (${id}, ${name}, ${email ?? null}, ${keyHash}, 'live')
        RETURNING id, name, email, mode, created_at
      `;

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
  app.post('/v1/keys/rotate', async (request, reply) => {
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
