import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { decodeTokenClaims, signGrantToken, parseExpiresIn } from '../lib/crypto.js';

interface DelegateBody {
  parentGrantToken: string;
  subAgentId: string;
  scopes: string[];
  expiresIn?: string;
}

export async function delegateRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/grants/delegate
  app.post<{ Body: DelegateBody }>('/v1/grants/delegate', async (request, reply) => {
    const { parentGrantToken, subAgentId, scopes, expiresIn = '1h' } = request.body;

    if (!parentGrantToken || !subAgentId || !scopes?.length) {
      return reply.status(400).send({
        message: 'parentGrantToken, subAgentId, and scopes are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    // Decode parent token
    let parentClaims: Record<string, unknown>;
    try {
      parentClaims = decodeTokenClaims(parentGrantToken);
    } catch {
      return reply.status(400).send({ message: 'Invalid parentGrantToken', code: 'BAD_REQUEST', requestId: request.id });
    }

    const parentJti = parentClaims['jti'] as string | undefined;
    const parentGrnt = (parentClaims['grnt'] ?? parentClaims['jti']) as string | undefined;
    const parentAgt = parentClaims['agt'] as string | undefined;
    const parentScp = parentClaims['scp'] as string[] | undefined;
    const parentExp = parentClaims['exp'] as number | undefined;
    const parentDepth = (parentClaims['delegationDepth'] as number | undefined) ?? 0;

    if (!parentJti || !parentGrnt || !parentScp || !parentExp) {
      return reply.status(400).send({ message: 'Invalid parentGrantToken claims', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Check parent not revoked in Redis
    const redis = getRedis();
    const [parentTokenRevoked, parentGrantRevoked] = await Promise.all([
      redis.get(`revoked:tok:${parentJti}`),
      redis.get(`revoked:grant:${parentGrnt}`),
    ]);

    if (parentTokenRevoked || parentGrantRevoked) {
      return reply.status(400).send({ message: 'Parent grant has been revoked', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Validate scopes ⊆ parent scopes
    const invalidScopes = scopes.filter((s) => !parentScp.includes(s));
    if (invalidScopes.length > 0) {
      return reply.status(400).send({
        message: `Requested scopes exceed parent grant scopes: ${invalidScopes.join(', ')}`,
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Look up sub-agent
    const agentRows = await sql`
      SELECT id, did FROM agents WHERE id = ${subAgentId} AND developer_id = ${developerId} AND status = 'active'
    `;
    const subAgent = agentRows[0];
    if (!subAgent) {
      return reply.status(404).send({ message: 'Sub-agent not found', code: 'NOT_FOUND', requestId: request.id });
    }

    // Compute expiry: min(parent exp, now + expiresIn)
    const expiresSeconds = parseExpiresIn(expiresIn);
    const now = Date.now();
    const requestedExpiry = now + expiresSeconds * 1000;
    const parentExpiry = parentExp * 1000;
    const expiresAt = new Date(Math.min(requestedExpiry, parentExpiry));
    const expTimestamp = Math.floor(expiresAt.getTime() / 1000);

    const grantId = newGrantId();
    const jti = newTokenId();
    const refreshId = newRefreshTokenId();
    const delegationDepth = parentDepth + 1;

    // Insert grant with parent link
    await sql`
      INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at, parent_grant_id, delegation_depth)
      VALUES (
        ${grantId},
        ${subAgentId},
        ${parentClaims['sub'] as string},
        ${developerId},
        ${scopes},
        ${expiresAt},
        ${parentGrnt},
        ${delegationDepth}
      )
    `;

    // Insert grant token
    await sql`
      INSERT INTO grant_tokens (jti, grant_id, expires_at)
      VALUES (${jti}, ${grantId}, ${expiresAt})
    `;

    // Insert refresh token
    const refreshExpiresAt = new Date(now + 30 * 86400 * 1000);
    await sql`
      INSERT INTO refresh_tokens (id, grant_id, expires_at)
      VALUES (${refreshId}, ${grantId}, ${refreshExpiresAt})
    `;

    // Sign JWT with delegation claims
    const jwt = await signGrantToken({
      sub: parentClaims['sub'] as string,
      agt: subAgent['did'] as string,
      dev: developerId,
      scp: scopes,
      jti,
      grnt: grantId,
      exp: expTimestamp,
      ...(parentAgt !== undefined ? { parentAgt } : {}),
      parentGrnt,
      delegationDepth,
    });

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: expiresAt.toISOString(),
      scopes,
      grantId,
    });
  });
}
