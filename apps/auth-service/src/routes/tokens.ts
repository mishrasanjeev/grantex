import type { FastifyInstance } from 'fastify';
import { getRedis } from '../redis/client.js';
import { checkActiveGrantToken } from '../lib/active-grant-token.js';
import { getSql, type TxSql } from '../db/client.js';
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
  // Containment: counted apart from the plan, and not refused by a limiter
  // outage (plugins/dynamicRateLimit.ts).
  app.post<{ Body: { jti: string } }>('/v1/tokens/revoke', { config: { rateLimitClass: 'containment' } }, async (request, reply) => {
    const body = request.body;
    const jti = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body.jti
      : undefined;
    if (typeof jti !== 'string' || jti.length === 0 || jti.length > 512) {
      return reply.status(400).send({ message: 'jti is required', code: 'BAD_REQUEST', requestId: request.id });
    }
    const sql = getSql();

    // The token, then the per-merchant child grants exchanged from it
    // (spec/passport-binding.md §8.5; RFC 8693 §2.1 leaves propagating
    // revocation to the deployment), in one transaction but two statements.
    // An exchange holds FOR SHARE on the parent token row until it commits
    // its child, and the first UPDATE waits that out. Under READ COMMITTED
    // every part of one statement shares one snapshot, so a single statement
    // would not see a child committed while it waited and would leave it
    // active; the second statement takes a fresh snapshot and does. An
    // exchange that starts after the first UPDATE waits on its row lock and
    // then reads the token as revoked. A token without children, which is
    // every token until PASSPORT_BOUND_GRANTS_ENABLED issues one, is revoked
    // exactly as before.
    const revocation = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const rows = await tx`
        UPDATE grant_tokens gt
        SET is_revoked = TRUE
        FROM grants g
        WHERE gt.jti = ${jti}
          AND gt.grant_id = g.id
          AND g.developer_id = ${request.developer.id}
          AND gt.is_revoked = FALSE
        RETURNING gt.jti, gt.expires_at
      `;
      const parent = rows[0];
      if (!parent) return null;
      const children = await tx`
        UPDATE grant_tokens child
        SET is_revoked = TRUE
        FROM grant_child_tokens link
        WHERE link.parent_jti = ${jti}
          AND link.developer_id = ${request.developer.id}
          AND child.jti = link.jti
          AND child.is_revoked = FALSE
        RETURNING child.jti, child.expires_at
      `;
      return {
        expiresAt: parent['expires_at'] as string,
        children: children.map((child) => ({ jti: child['jti'] as string, expires_at: child['expires_at'] as string })),
      };
    });

    if (!revocation) {
      return reply.status(404).send({ message: 'Token not found or already revoked', code: 'NOT_FOUND', requestId: request.id });
    }

    // Set Redis revocation keys
    const redis = getRedis();
    for (const revoked of [{ jti, expires_at: revocation.expiresAt }, ...revocation.children]) {
      const expiresAt = new Date(revoked.expires_at);
      const ttl = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      try {
        await redis.set(`revoked:tok:${revoked.jti}`, '1', 'EX', ttl);
      } catch {
        // The database flag is authoritative; a cache outage must not make an
        // already-committed revocation appear to have failed.
      }
    }

    return reply.status(204).send();
  });
}
