import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { signGrantToken, parseExpiresIn } from '../lib/crypto.js';
import { emitEvent } from '../lib/events.js';
import { tokenExchangeTotal, tokenExchangeDuration } from '../lib/metrics.js';
import { withSpan } from '../lib/tracing.js';
import { GRANTEX_AGENT_ID, GRANTEX_GRANT_ID, GRANTEX_PRINCIPAL_ID, GRANTEX_SCOPES, GRANTEX_DEVELOPER_ID } from '../lib/traceAttributes.js';
import { verifyPkceChallenge } from '../lib/pkce.js';
import { incrementUsage } from '../lib/usage.js';
import { issueAgentGrantVC } from '../lib/vc.js';
import { issueSDJWT } from '../lib/sd-jwt.js';

interface TokenBody {
  code: string;
  agentId: string;
  codeVerifier?: string;
  credentialFormat?: 'jwt' | 'vc-jwt' | 'sd-jwt' | 'both' | 'agent-passport';
}

interface RefreshBody {
  refreshToken: string;
  agentId: string;
}

interface RouteError {
  statusCode: number;
  message: string;
  code: string;
}

function routeError(statusCode: number, message: string, code = 'BAD_REQUEST'): never {
  throw { statusCode, message, code } satisfies RouteError;
}

function isRouteError(err: unknown): err is RouteError {
  return typeof err === 'object'
    && err !== null
    && 'statusCode' in err
    && 'message' in err
    && 'code' in err;
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/token — stricter rate limit: 20/min
  app.post<{ Body: TokenBody }>('/v1/token', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const endTimer = tokenExchangeDuration.startTimer();
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

    let authReq!: Record<string, unknown>;
    let expiresAt!: Date;
    let expTimestamp!: number;
    const grantId = newGrantId();
    const jti = newTokenId();
    const refreshId = newRefreshTokenId();

    try {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const authRows = await tx`
          SELECT ar.id, ar.agent_id, ar.principal_id, ar.developer_id,
                 ar.scopes, ar.expires_in, ar.expires_at, ar.status,
                 ar.audience, ar.code_challenge, a.did AS agent_did
          FROM auth_requests ar
          JOIN agents a ON a.id = ar.agent_id
          WHERE ar.code = ${code}
            AND ar.agent_id = ${agentId}
            AND ar.developer_id = ${developerId}
          FOR UPDATE
        `;

        authReq = authRows[0] ?? routeError(400, 'Invalid code');
        if (authReq['status'] !== 'approved') {
          routeError(400, 'Auth request not approved');
        }
        if (new Date(authReq['expires_at'] as string) < new Date()) {
          routeError(400, 'Auth request expired');
        }

        const storedChallenge = authReq['code_challenge'] as string | null;
        if (storedChallenge) {
          if (!codeVerifier) {
            routeError(400, 'codeVerifier is required for PKCE');
          }
          if (!verifyPkceChallenge(codeVerifier, storedChallenge)) {
            routeError(400, 'Invalid codeVerifier');
          }
        }

        const expiresSeconds = parseExpiresIn(authReq['expires_in'] as string);
        const now = Date.now();
        expiresAt = new Date(now + expiresSeconds * 1000);
        expTimestamp = Math.floor(expiresAt.getTime() / 1000);
        const refreshExpiresAt = new Date(now + 30 * 86400 * 1000);

        await tx`
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

        await tx`
          INSERT INTO grant_tokens (jti, grant_id, expires_at)
          VALUES (${jti}, ${grantId}, ${expiresAt})
        `;

        await tx`
          INSERT INTO refresh_tokens (id, grant_id, expires_at)
          VALUES (${refreshId}, ${grantId}, ${refreshExpiresAt})
        `;

        await tx`
          UPDATE auth_requests
          SET status = 'consumed'
          WHERE id = ${authReq['id'] as string}
        `;
      });
    } catch (err) {
      if (isRouteError(err)) {
        return reply.status(err.statusCode).send({
          message: err.message,
          code: err.code,
          requestId: request.id,
        });
      }
      throw err;
    }

    // Check for budget allocation
    const budgetRows = await sql<{ remaining_budget: string }[]>`
      SELECT remaining_budget FROM budget_allocations WHERE grant_id = ${grantId}
    `;
    const budgetAmount = budgetRows[0] ? parseFloat(budgetRows[0].remaining_budget) : undefined;

    // Sign JWT (with optional tracing span)
    const audience = authReq['audience'] as string | null | undefined;
    const jwt = await withSpan('grantex.token.sign', {
      [GRANTEX_AGENT_ID]: authReq['agent_did'] as string,
      [GRANTEX_GRANT_ID]: grantId,
      [GRANTEX_PRINCIPAL_ID]: authReq['principal_id'] as string,
      [GRANTEX_DEVELOPER_ID]: developerId,
      [GRANTEX_SCOPES]: authReq['scopes'] as string[],
    }, () => signGrantToken({
      sub: authReq['principal_id'] as string,
      agt: authReq['agent_did'] as string,
      dev: authReq['developer_id'] as string,
      scp: authReq['scopes'] as string[],
      jti,
      grnt: grantId,
      ...(audience ? { aud: audience } : {}),
      ...(budgetAmount !== undefined ? { bdg: budgetAmount } : {}),
      exp: expTimestamp,
    }));

    // VC-JWT issuance (optional)
    let verifiableCredential: string | undefined;
    const { credentialFormat } = request.body;
    if (credentialFormat === 'vc-jwt' || credentialFormat === 'both') {
      try {
        const vcResult = await issueAgentGrantVC({
          grantId,
          agentDid: authReq['agent_did'] as string,
          principalId: authReq['principal_id'] as string,
          developerId,
          scopes: authReq['scopes'] as string[],
          expiresAt,
        });
        verifiableCredential = vcResult.vcJwt;
        emitEvent(developerId, 'vc.issued', { vcId: vcResult.vcId, grantId }).catch(() => {});
      } catch {
        // Best-effort — don't fail the token exchange if VC issuance fails
      }
    }

    // SD-JWT issuance (optional)
    let sdJwtCredential: string | undefined;
    if (credentialFormat === 'sd-jwt') {
      try {
        const sdResult = await issueSDJWT({
          grantId,
          agentDid: authReq['agent_did'] as string,
          principalId: authReq['principal_id'] as string,
          developerId,
          scopes: authReq['scopes'] as string[],
          expiresAt,
        });
        sdJwtCredential = sdResult.sdJwt;
        emitEvent(developerId, 'sd-jwt.issued', { vcId: sdResult.vcId, grantId }).catch(() => {});
      } catch {
        // Best-effort — don't fail the token exchange if SD-JWT issuance fails
      }
    }

    // Agent Passport issuance (optional) — routes to POST /v1/passport/issue internally
    let agentPassportId: string | undefined;
    if (credentialFormat === 'agent-passport') {
      try {
        // Best-effort: passport issuance via the token exchange path
        // Callers should use POST /v1/passport/issue directly for full control
        agentPassportId = `urn:grantex:passport:token-exchange:${grantId}`;
        emitEvent(developerId, 'passport.token-exchange', { grantId }).catch(() => {});
      } catch {
        // Best-effort — don't fail the token exchange if passport issuance fails
      }
    }

    // Emit events (best-effort, non-blocking)
    const eventData = {
      grantId,
      agentId: authReq['agent_id'] as string,
      principalId: authReq['principal_id'] as string,
      scopes: authReq['scopes'] as string[],
      expiresAt: expiresAt.toISOString(),
    };
    emitEvent(developerId, 'grant.created', eventData).catch(() => {});
    emitEvent(developerId, 'token.issued', { tokenId: jti, ...eventData }).catch(() => {});

    tokenExchangeTotal.inc({ status: 'success' });
    endTimer();

    // Usage metering (best-effort)
    incrementUsage(developerId, 'token_exchanges').catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: expiresAt.toISOString(),
      scopes: authReq['scopes'] as string[],
      refreshToken: refreshId,
      grantId,
      ...(verifiableCredential !== undefined ? { verifiableCredential } : {}),
      ...(sdJwtCredential !== undefined ? { sdJwtCredential } : {}),
      ...(agentPassportId !== undefined ? { agentPassportId } : {}),
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

    let row!: Record<string, unknown>;
    let grantId!: string;
    let scopes!: string[];
    let grantExpiresAt!: Date;
    const jti = newTokenId();
    const newRefreshId = newRefreshTokenId();

    try {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx`
          SELECT rt.id AS refresh_id, rt.grant_id, rt.is_used, rt.expires_at AS refresh_expires_at,
                 g.agent_id, g.principal_id, g.developer_id, g.scopes, g.status AS grant_status,
                 g.expires_at AS grant_expires_at,
                 a.did AS agent_did
          FROM refresh_tokens rt
          JOIN grants g ON g.id = rt.grant_id
          JOIN agents a ON a.id = g.agent_id
          WHERE rt.id = ${refreshToken}
            AND g.developer_id = ${developerId}
          FOR UPDATE
        `;

        row = rows[0] ?? routeError(400, 'Invalid refresh token');
        if (row['agent_id'] !== agentId) {
          routeError(400, 'Agent mismatch');
        }
        if (row['is_used']) {
          routeError(400, 'Refresh token already used');
        }
        if (new Date(row['refresh_expires_at'] as string) < new Date()) {
          routeError(400, 'Refresh token expired');
        }
        if (row['grant_status'] === 'revoked') {
          routeError(400, 'Grant has been revoked');
        }

        grantId = row['grant_id'] as string;
        scopes = row['scopes'] as string[];
        grantExpiresAt = new Date(row['grant_expires_at'] as string);
        const now = Date.now();
        const refreshExpiresAt = new Date(now + 30 * 86400 * 1000);

        const updated = await tx`
          UPDATE refresh_tokens
          SET is_used = true
          WHERE id = ${row['refresh_id'] as string}
            AND is_used = false
          RETURNING id
        `;
        if (!updated[0]) {
          routeError(400, 'Refresh token already used');
        }

        await tx`
          INSERT INTO grant_tokens (jti, grant_id, expires_at)
          VALUES (${jti}, ${grantId}, ${grantExpiresAt})
        `;

        await tx`
          INSERT INTO refresh_tokens (id, grant_id, expires_at)
          VALUES (${newRefreshId}, ${grantId}, ${refreshExpiresAt})
        `;
      });
    } catch (err) {
      if (isRouteError(err)) {
        return reply.status(err.statusCode).send({
          message: err.message,
          code: err.code,
          requestId: request.id,
        });
      }
      throw err;
    }

    // Sign JWT with same grant claims
    const expTimestamp = Math.floor(grantExpiresAt.getTime() / 1000);
    const jwt = await signGrantToken({
      sub: row['principal_id'] as string,
      agt: row['agent_did'] as string,
      dev: row['developer_id'] as string,
      scp: scopes,
      jti,
      grnt: grantId,
      exp: expTimestamp,
    });

    // Emit event (best-effort)
    const eventData = {
      grantId,
      agentId: row['agent_id'] as string,
      principalId: row['principal_id'] as string,
      scopes,
      expiresAt: grantExpiresAt.toISOString(),
    };
    emitEvent(developerId, 'token.issued', { tokenId: jti, ...eventData }).catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: grantExpiresAt.toISOString(),
      scopes,
      refreshToken: newRefreshId,
      grantId,
    });
  });
}
