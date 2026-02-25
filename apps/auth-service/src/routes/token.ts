import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { signGrantToken, parseExpiresIn } from '../lib/crypto.js';

interface TokenBody {
  code: string;
  agentId: string;
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/token
  app.post<{ Body: TokenBody }>('/v1/token', async (request, reply) => {
    const { code, agentId } = request.body;

    if (!code || !agentId) {
      return reply.status(400).send({
        message: 'code and agentId are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Validate code + agentId
    const authRows = await sql`
      SELECT ar.id, ar.agent_id, ar.principal_id, ar.developer_id,
             ar.scopes, ar.expires_in, ar.expires_at, ar.status,
             a.did AS agent_did
      FROM auth_requests ar
      JOIN agents a ON a.id = ar.agent_id
      WHERE ar.code = ${code}
        AND ar.agent_id = ${agentId}
        AND ar.developer_id = ${developerId}
    `;

    const authReq = authRows[0];
    if (!authReq) {
      return reply.status(400).send({ message: 'Invalid code', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (authReq['status'] !== 'approved') {
      return reply.status(400).send({ message: 'Auth request not approved', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (new Date(authReq['expires_at'] as string) < new Date()) {
      return reply.status(400).send({ message: 'Auth request expired', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Parse expiry
    const expiresInStr = authReq['expires_in'] as string;
    const expiresSeconds = parseExpiresIn(expiresInStr);
    const now = Date.now();
    const expiresAt = new Date(now + expiresSeconds * 1000);
    const expTimestamp = Math.floor(expiresAt.getTime() / 1000);

    const grantId = newGrantId();
    const jti = newTokenId();
    const refreshId = newRefreshTokenId();

    // Create grant
    await sql`
      INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
      VALUES (
        ${grantId},
        ${authReq['agent_id'] as string},
        ${authReq['principal_id'] as string},
        ${authReq['developer_id'] as string},
        ${authReq['scopes'] as string[]},
        ${expiresAt}
      )
    `;

    // Create grant token record
    await sql`
      INSERT INTO grant_tokens (jti, grant_id, expires_at)
      VALUES (${jti}, ${grantId}, ${expiresAt})
    `;

    // Create refresh token
    const refreshExpiresAt = new Date(now + 30 * 86400 * 1000); // 30 days
    await sql`
      INSERT INTO refresh_tokens (id, grant_id, expires_at)
      VALUES (${refreshId}, ${grantId}, ${refreshExpiresAt})
    `;

    // Mark auth request as consumed
    await sql`
      UPDATE auth_requests SET status = 'consumed' WHERE id = ${authReq['id'] as string}
    `;

    // Sign JWT
    const jwt = await signGrantToken({
      sub: authReq['principal_id'] as string,
      agt: authReq['agent_did'] as string,
      dev: authReq['developer_id'] as string,
      scp: authReq['scopes'] as string[],
      jti,
      gid: grantId,
      exp: expTimestamp,
    });

    return reply.status(201).send({
      accessToken: jwt,
      tokenType: 'Bearer',
      expiresIn: expiresSeconds,
      refreshToken: refreshId,
      grantId,
    });
  });
}
