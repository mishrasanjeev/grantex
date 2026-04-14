import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { revokeGrantCascade } from '../lib/revoke.js';
import { checkActiveGrantToken } from '../lib/active-grant-token.js';
import { incrementUsage } from '../lib/usage.js';

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
    const result = await revokeGrantCascade(request.params.id, request.developer.id);

    if (!result.revoked) {
      return reply.status(404).send({ message: 'Grant not found or already revoked', code: 'NOT_FOUND', requestId: request.id });
    }

    return reply.status(204).send();
  });

  // POST /v1/grants/verify
  app.post<{ Body: { token: string } }>('/v1/grants/verify', async (request, reply) => {
    const { token } = request.body;
    if (!token) {
      return reply.status(400).send({ message: 'token is required', code: 'BAD_REQUEST', requestId: request.id });
    }

    const result = await checkActiveGrantToken(token, {
      expectedDeveloperId: request.developer.id,
    });

    incrementUsage(request.developer.id, 'verifications').catch(() => {});

    if (!result.ok) {
      if (result.reason === 'invalid' || result.reason === 'invalid_claims') {
        return reply.status(400).send({ message: 'Invalid token', code: 'BAD_REQUEST', requestId: request.id });
      }
      return reply.send({ active: false, reason: result.reason });
    }

    return reply.send({ active: true, claims: result.claims });
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
    ...(row['parent_grant_id'] !== null && row['parent_grant_id'] !== undefined
      ? { parentGrantId: row['parent_grant_id'] }
      : {}),
    delegationDepth: (row['delegation_depth'] as number | undefined) ?? 0,
  };
}
