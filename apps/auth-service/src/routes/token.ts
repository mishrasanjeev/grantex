import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { signGrantToken, parseExpiresIn } from '../lib/crypto.js';
import { fireWebhooks } from '../lib/webhook.js';
import { verifyPkceChallenge } from '../lib/pkce.js';

interface TokenBody {
  code: string;
  agentId: string;
  codeVerifier?: string;
}

interface RefreshBody {
  refreshToken: string;
  agentId: string;
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/token — stricter rate limit: 20/min
  app.post<{ Body: TokenBody }>('/v1/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { code, agentId, codeVerifier } = request.body;

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
             ar.audience, ar.code_challenge, a.did AS agent_did
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

    // PKCE verification
    const storedChallenge = authReq['code_challenge'] as string | null;
    if (storedChallenge) {
      if (!codeVerifier) {
        return reply.status(400).send({ message: 'codeVerifier is required for PKCE', code: 'BAD_REQUEST', requestId: request.id });
      }
      if (!verifyPkceChallenge(codeVerifier, storedChallenge)) {
        return reply.status(400).send({ message: 'Invalid codeVerifier', code: 'BAD_REQUEST', requestId: request.id });
      }
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
    const audience = authReq['audience'] as string | null | undefined;
    const jwt = await signGrantToken({
      sub: authReq['principal_id'] as string,
      agt: authReq['agent_did'] as string,
      dev: authReq['developer_id'] as string,
      scp: authReq['scopes'] as string[],
      jti,
      grnt: grantId,
      ...(audience ? { aud: audience } : {}),
      exp: expTimestamp,
    });

    // Fire webhook events (best-effort, non-blocking)
    const webhookData = {
      grantId,
      agentId: authReq['agent_id'] as string,
      principalId: authReq['principal_id'] as string,
      scopes: authReq['scopes'] as string[],
      expiresAt: expiresAt.toISOString(),
    };
    fireWebhooks(developerId, 'grant.created', webhookData).catch(() => {});
    fireWebhooks(developerId, 'token.issued', { tokenId: jti, ...webhookData }).catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: expiresAt.toISOString(),
      scopes: authReq['scopes'] as string[],
      refreshToken: refreshId,
      grantId,
    });
  });

  // POST /v1/token/refresh — refresh a grant token (single-use rotation)
  app.post<{ Body: RefreshBody }>('/v1/token/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { refreshToken, agentId } = request.body;

    if (!refreshToken || !agentId) {
      return reply.status(400).send({
        message: 'refreshToken and agentId are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Look up refresh token, joining grants and agents
    const rows = await sql`
      SELECT rt.id AS refresh_id, rt.grant_id, rt.is_used, rt.expires_at AS refresh_expires_at,
             g.agent_id, g.principal_id, g.developer_id, g.scopes, g.status AS grant_status,
             g.expires_at AS grant_expires_at,
             a.did AS agent_did
      FROM refresh_tokens rt
      JOIN grants g ON g.id = rt.grant_id
      JOIN agents a ON a.id = g.agent_id
      WHERE rt.id = ${refreshToken}
        AND g.developer_id = ${developerId}
    `;

    const row = rows[0];
    if (!row) {
      return reply.status(400).send({ message: 'Invalid refresh token', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (row['agent_id'] !== agentId) {
      return reply.status(400).send({ message: 'Agent mismatch', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (row['is_used']) {
      return reply.status(400).send({ message: 'Refresh token already used', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (new Date(row['refresh_expires_at'] as string) < new Date()) {
      return reply.status(400).send({ message: 'Refresh token expired', code: 'BAD_REQUEST', requestId: request.id });
    }

    if (row['grant_status'] === 'revoked') {
      return reply.status(400).send({ message: 'Grant has been revoked', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Mark old refresh token as used
    await sql`UPDATE refresh_tokens SET is_used = true WHERE id = ${row['refresh_id'] as string}`;

    const grantId = row['grant_id'] as string;
    const scopes = row['scopes'] as string[];
    const now = Date.now();

    // Use remaining grant expiry window for the new token
    const grantExpiresAt = new Date(row['grant_expires_at'] as string);
    const expTimestamp = Math.floor(grantExpiresAt.getTime() / 1000);

    const jti = newTokenId();
    const newRefreshId = newRefreshTokenId();

    // Create new grant token record
    await sql`
      INSERT INTO grant_tokens (jti, grant_id, expires_at)
      VALUES (${jti}, ${grantId}, ${grantExpiresAt})
    `;

    // Create new refresh token (30-day TTL)
    const refreshExpiresAt = new Date(now + 30 * 86400 * 1000);
    await sql`
      INSERT INTO refresh_tokens (id, grant_id, expires_at)
      VALUES (${newRefreshId}, ${grantId}, ${refreshExpiresAt})
    `;

    // Sign JWT with same grant claims
    const jwt = await signGrantToken({
      sub: row['principal_id'] as string,
      agt: row['agent_did'] as string,
      dev: row['developer_id'] as string,
      scp: scopes,
      jti,
      grnt: grantId,
      exp: expTimestamp,
    });

    // Fire webhook (best-effort)
    const webhookData = {
      grantId,
      agentId: row['agent_id'] as string,
      principalId: row['principal_id'] as string,
      scopes,
      expiresAt: grantExpiresAt.toISOString(),
    };
    fireWebhooks(developerId, 'token.issued', { tokenId: jti, ...webhookData }).catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: grantExpiresAt.toISOString(),
      scopes,
      refreshToken: newRefreshId,
      grantId,
    });
  });
}
