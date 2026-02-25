import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { decodeTokenClaims } from '../lib/crypto.js';

export async function grantsRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/grants
  app.get('/v1/grants', async (request, reply) => {
    const sql = getSql();
    const query = request.query as Record<string, string>;
    const developerId = request.developer.id;

    const agentId = query['agentId'] ?? null;
    const principalId = query['principalId'] ?? null;
    const status = query['status'] ?? null;

    const rows = await sql`
      SELECT id, agent_id, principal_id, developer_id, scopes, status, issued_at, expires_at, revoked_at
      FROM grants
      WHERE developer_id = ${developerId}
        AND (${agentId}::text IS NULL OR agent_id = ${agentId ?? ''})
        AND (${principalId}::text IS NULL OR principal_id = ${principalId ?? ''})
        AND (${status}::text IS NULL OR status = ${status ?? ''})
      ORDER BY issued_at DESC
    `;

    return reply.send({ grants: rows.map(toGrantResponse) });
  });

  // GET /v1/grants/:id
  app.get<{ Params: { id: string } }>('/v1/grants/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      SELECT id, agent_id, principal_id, developer_id, scopes, status, issued_at, expires_at, revoked_at
      FROM grants
      WHERE id = ${request.params.id} AND developer_id = ${request.developer.id}
    `;
    const grant = rows[0];
    if (!grant) {
      return reply.status(404).send({ message: 'Grant not found', code: 'NOT_FOUND', requestId: request.id });
    }
    return reply.send(toGrantResponse(grant));
  });

  // DELETE /v1/grants/:id  (revoke)
  app.delete<{ Params: { id: string } }>('/v1/grants/:id', async (request, reply) => {
    const sql = getSql();
    const rows = await sql`
      UPDATE grants
      SET status = 'revoked', revoked_at = NOW()
      WHERE id = ${request.params.id}
        AND developer_id = ${request.developer.id}
        AND status = 'active'
      RETURNING id, expires_at
    `;

    const grant = rows[0];
    if (!grant) {
      return reply.status(404).send({ message: 'Grant not found or already revoked', code: 'NOT_FOUND', requestId: request.id });
    }

    // Set Redis revocation key with TTL
    const redis = getRedis();
    const expiresAt = new Date(grant['expires_at'] as string);
    const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    await redis.set(`revoked:grant:${request.params.id}`, '1', 'EX', ttlSeconds);

    return reply.status(204).send();
  });

  // POST /v1/grants/verify
  app.post<{ Body: { token: string } }>('/v1/grants/verify', async (request, reply) => {
    const { token } = request.body;
    if (!token) {
      return reply.status(400).send({ message: 'token is required', code: 'BAD_REQUEST', requestId: request.id });
    }

    let claims: Record<string, unknown>;
    try {
      claims = decodeTokenClaims(token);
    } catch {
      return reply.status(400).send({ message: 'Invalid token', code: 'BAD_REQUEST', requestId: request.id });
    }

    const jti = claims['jti'] as string;
    const gid = (claims['gid'] ?? claims['jti']) as string;

    // Check Redis first
    const redis = getRedis();
    const [tokenRevoked, grantRevoked] = await Promise.all([
      redis.get(`revoked:tok:${jti}`),
      redis.get(`revoked:grant:${gid}`),
    ]);

    if (tokenRevoked || grantRevoked) {
      return reply.send({ active: false, reason: 'revoked' });
    }

    // Check DB
    const sql = getSql();
    const tokenRows = await sql`
      SELECT gt.is_revoked, gt.expires_at, g.status AS grant_status
      FROM grant_tokens gt
      JOIN grants g ON g.id = gt.grant_id
      WHERE gt.jti = ${jti} AND g.developer_id = ${request.developer.id}
    `;

    const row = tokenRows[0];
    if (!row) {
      return reply.send({ active: false, reason: 'not_found' });
    }
    if (row['is_revoked'] || row['grant_status'] !== 'active') {
      return reply.send({ active: false, reason: 'revoked' });
    }
    if (new Date(row['expires_at'] as string) < new Date()) {
      return reply.send({ active: false, reason: 'expired' });
    }

    return reply.send({ active: true, claims });
  });
}

function toGrantResponse(row: Record<string, unknown>) {
  return {
    grantId: row['id'],
    agentId: row['agent_id'],
    principalId: row['principal_id'],
    developerId: row['developer_id'],
    scopes: row['scopes'],
    status: row['status'],
    issuedAt: row['issued_at'],
    expiresAt: row['expires_at'],
    ...(row['revoked_at'] !== null && row['revoked_at'] !== undefined
      ? { revokedAt: row['revoked_at'] }
      : {}),
  };
}
