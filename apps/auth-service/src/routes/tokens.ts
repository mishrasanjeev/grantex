import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { decodeTokenClaims } from '../lib/crypto.js';

export async function tokensRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/tokens/introspect
  app.post<{ Body: { token: string } }>('/v1/tokens/introspect', async (request, reply) => {
    const { token } = request.body;
    if (!token) {
      return reply.status(400).send({ message: 'token is required', code: 'BAD_REQUEST', requestId: request.id });
    }

    let claims: Record<string, unknown>;
    try {
      claims = decodeTokenClaims(token);
    } catch {
      return reply.send({ active: false });
    }

    const jti = claims['jti'] as string | undefined;
    const gid = (claims['gid'] ?? claims['jti']) as string | undefined;

    if (!jti) return reply.send({ active: false });

    // Redis check first
    const redis = getRedis();
    const [tokenRevoked, grantRevoked] = await Promise.all([
      redis.get(`revoked:tok:${jti}`),
      gid ? redis.get(`revoked:grant:${gid}`) : Promise.resolve(null),
    ]);

    if (tokenRevoked || grantRevoked) {
      return reply.send({ active: false });
    }

    // DB check
    const sql = getSql();
    const rows = await sql`
      SELECT gt.is_revoked, gt.expires_at, g.status AS grant_status
      FROM grant_tokens gt
      JOIN grants g ON g.id = gt.grant_id
      WHERE gt.jti = ${jti}
    `;

    const row = rows[0];
    if (!row) return reply.send({ active: false });

    if (row['is_revoked'] as boolean) {
      // Write-back to Redis
      const expiresAt = new Date(row['expires_at'] as string);
      const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      await redis.set(`revoked:tok:${jti}`, '1', 'EX', ttl);
      return reply.send({ active: false });
    }

    if (row['grant_status'] !== 'active') return reply.send({ active: false });

    const expiresAt = new Date(row['expires_at'] as string);
    if (expiresAt < new Date()) return reply.send({ active: false });

    return reply.send({
      active: true,
      sub: claims['sub'],
      agt: claims['agt'],
      dev: claims['dev'],
      scp: claims['scp'],
      iss: claims['iss'],
      jti,
      exp: claims['exp'],
      iat: claims['iat'],
      ...(claims['gid'] !== undefined ? { gid: claims['gid'] } : {}),
    });
  });

  // DELETE /v1/tokens/:jti  (revoke token)
  app.delete<{ Params: { jti: string } }>('/v1/tokens/:jti', async (request, reply) => {
    const { jti } = request.params;
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
    await redis.set(`revoked:tok:${jti}`, '1', 'EX', ttl);

    return reply.status(204).send();
  });
}
