import type { FastifyInstance } from 'fastify';
import { getRedis } from '../redis/client.js';
import { checkActiveGrantToken } from '../lib/active-grant-token.js';
import { getSql } from '../db/client.js';
import { incrementUsage } from '../lib/usage.js';

export async function tokensRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/tokens/verify
  app.post<{ Body: { token: string } }>('/v1/tokens/verify', async (request, reply) => {
    const body = request.body;
    const token = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body.token
      : undefined;
    if (typeof token !== 'string' || token.length === 0) {
      return reply.status(400).send({ message: 'token is required', code: 'BAD_REQUEST', requestId: request.id });
    }

    const result = await checkActiveGrantToken(token, {
      expectedDeveloperId: request.developer.id,
    });

    incrementUsage(request.developer.id, 'verifications').catch(() => {});

    if (!result.ok) {
      return reply.send({ valid: false });
    }

    const { claims } = result;

    return reply.send({
      valid: true,
      grantId: claims.grnt,
      scopes: claims.scp,
      principal: claims.sub,
      agent: claims.agt,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    });
  });

  // POST /v1/tokens/revoke
  app.post<{ Body: { jti: string } }>('/v1/tokens/revoke', async (request, reply) => {
    const body = request.body;
    const jti = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body.jti
      : undefined;
    if (typeof jti !== 'string' || jti.length === 0 || jti.length > 512) {
      return reply.status(400).send({ message: 'jti is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const sql = getSql();

    const rows = await sql`
      UPDATE grant_tokens gt
      SET is_revoked = TRUE
      FROM grants g
      WHERE gt.jti = ${jti}
        AND gt.grant_id = g.id
        AND g.developer_id = ${request.developer.id}
        AND gt.is_revoked = FALSE
      RETURNING gt.jti, gt.expires_at
    `;

    const row = rows[0];
    if (!row) {
      return reply.status(404).send({ message: 'Token not found or already revoked', code: 'NOT_FOUND', requestId: request.id });
    }

    // Set Redis revocation key
    const redis = getRedis();
    const expiresAt = new Date(row['expires_at'] as string);
    const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    try {
      await redis.set(`revoked:tok:${jti}`, '1', 'EX', ttl);
    } catch {
      // The database flag is authoritative; a cache outage must not make an
      // already-committed revocation appear to have failed.
    }

    return reply.status(204).send();
  });
}
