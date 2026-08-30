import type { FastifyInstance } from 'fastify';
import { getSql, type TxSql } from '../db/client.js';
import { newGrantId, newTokenId, newRefreshTokenId } from '../lib/ids.js';
import { signGrantToken, parseExpiresIn } from '../lib/crypto.js';
import { emitEvent } from '../lib/events.js';
import { tokenExchangeTotal, tokenExchangeDuration } from '../lib/metrics.js';
import { withSpan } from '../lib/tracing.js';
import { GRANTEX_AGENT_ID, GRANTEX_GRANT_ID, GRANTEX_PRINCIPAL_ID, GRANTEX_SCOPES, GRANTEX_DEVELOPER_ID } from '../lib/traceAttributes.js';
import { isValidPkceVerifier, verifyPkceChallenge } from '../lib/pkce.js';
import { incrementUsage } from '../lib/usage.js';
import { issueAgentGrantVC } from '../lib/vc.js';
import { issueSDJWT } from '../lib/sd-jwt.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import { createHash, timingSafeEqual } from 'node:crypto';

interface TokenBody {
  code: string;
  agentId: string;
  codeVerifier?: string;
  redirectUri?: string;
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

const REFRESH_TOKEN_REPLAY_WINDOW_SECONDS = 300;
const REFRESH_TOKEN_ALREADY_USED = 'Refresh token already used';

function refreshReplayRequestHash(
  developerId: string,
  agentId: string,
  refreshToken: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`grantex-refresh-replay:v2\0${developerId}\0${agentId}\0${refreshToken}\0${idempotencyKey}`)
    .digest('hex');
}

function replayHashMatches(stored: unknown, candidate: string | null): boolean {
  if (typeof stored !== 'string' || stored.length !== 64 || candidate === null || candidate.length !== 64) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
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
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.status(400).send({ message: 'Request body must be a JSON object', code: 'BAD_REQUEST', requestId: request.id });
    }
    const { code, agentId, codeVerifier, redirectUri, credentialFormat } = body;

    if (typeof code !== 'string' || code.length === 0 || code.length > 512
        || typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) {
      return reply.status(400).send({
        message: 'code and agentId are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    if (codeVerifier !== undefined && typeof codeVerifier !== 'string') {
      return reply.status(400).send({ message: 'codeVerifier must be a string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (redirectUri !== undefined && (typeof redirectUri !== 'string' || redirectUri.length === 0 || redirectUri.length > 2048)) {
      return reply.status(400).send({ message: 'redirectUri must be a non-empty string', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (credentialFormat !== undefined
        && !['jwt', 'vc-jwt', 'sd-jwt', 'both', 'agent-passport'].includes(credentialFormat)) {
      return reply.status(400).send({ message: 'Invalid credentialFormat', code: 'BAD_REQUEST', requestId: request.id });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    let authReq!: Record<string, unknown>;
    let expiresAt!: Date;
    let expTimestamp!: number;
    let jwt!: string;
    const grantId = newGrantId();
    const jti = newTokenId();
    const refreshId = newRefreshTokenId();

    try {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const authRows = await tx`
          SELECT ar.id, ar.agent_id, ar.principal_id, ar.developer_id,
                 ar.scopes, ar.expires_in, ar.expires_at, ar.status,
                 ar.audience, ar.redirect_uri, ar.code_challenge,
                 ar.agent_key_thumbprint, a.did AS agent_did
          FROM auth_requests ar
          JOIN agents a ON a.id = ar.agent_id
          WHERE ar.code = ${code}
            AND ar.agent_id = ${agentId}
            AND ar.developer_id = ${developerId}
            AND a.status = 'active'
          FOR UPDATE OF ar, a
        `;

        authReq = authRows[0] ?? routeError(400, 'Invalid code');
        if (authReq['status'] !== 'approved') {
          routeError(400, 'Auth request not approved');
        }
        if (new Date(authReq['expires_at'] as string) < new Date()) {
          routeError(400, 'Auth request expired');
        }

        const registeredRedirectUri = authReq['redirect_uri'];
        if (typeof registeredRedirectUri === 'string' && redirectUri !== registeredRedirectUri) {
          routeError(400, 'redirectUri must exactly match the authorization request', 'REDIRECT_URI_MISMATCH');
        }

        const storedChallenge = authReq['code_challenge'] as string | null;
        if (storedChallenge) {
          if (codeVerifier === undefined) {
            routeError(400, 'codeVerifier is required for PKCE');
          }
          if (!isValidPkceVerifier(codeVerifier)) {
            routeError(400, 'Invalid codeVerifier');
          }
          if (!verifyPkceChallenge(codeVerifier, storedChallenge)) {
            routeError(400, 'Invalid codeVerifier');
          }
        }

        const expiresSeconds = parseExpiresIn(authReq['expires_in'] as string);
        const now = Date.now();
        expiresAt = new Date(now + expiresSeconds * 1000);
        expTimestamp = Math.floor(expiresAt.getTime() / 1000);
        // Refresh tokens cannot outlive the underlying grant.
        const refreshExpiresAt = new Date(Math.min(now + 30 * 86400 * 1000, expiresAt.getTime()));

        // The plan limit must be enforced where the grant is actually created.
        // Serializing issuance per developer closes the check-then-insert race and
        // prevents many already-approved codes from exceeding the subscription.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 3))`;
        const planRows = await tx`
          SELECT
            COALESCE((SELECT plan FROM subscriptions WHERE developer_id = ${developerId} LIMIT 1), 'free') AS plan,
            (SELECT COUNT(*) FROM grants
             WHERE developer_id = ${developerId} AND status = 'active' AND expires_at > NOW()) AS count
        `;
        const planName = (planRows[0]?.['plan'] as string | undefined) ?? 'free';
        const plan = isPlanName(planName) ? planName : 'free';
        const grantCount = Number(planRows[0]?.['count'] ?? 0);
        const grantLimit = PLAN_LIMITS[plan].grants;
        if (!Number.isSafeInteger(grantCount) || grantCount >= grantLimit) {
          routeError(
            402,
            `Plan limit reached: ${plan} plan allows ${grantLimit} active grant(s)`,
            'PLAN_LIMIT_EXCEEDED',
          );
        }

        await tx`
          INSERT INTO grants (
            id, agent_id, principal_id, developer_id, scopes, expires_at,
            audience, agent_key_thumbprint
          )
          VALUES (
            ${grantId},
            ${authReq['agent_id'] as string},
            ${authReq['principal_id'] as string},
            ${authReq['developer_id'] as string},
            ${authReq['scopes'] as string[]},
            ${expiresAt},
            ${authReq['audience'] as string | null},
            ${authReq['agent_key_thumbprint'] as string | null}
          )
        `;

        // No `bdg` claim at issuance. A budget is attached to a grant after the
        // fact via POST /v1/budget/allocate, which requires the grant to already
        // exist and be active — and this grant's id was generated a few lines
        // above, inside this same transaction. Querying budget_allocations for
        // it could therefore never return a row; it was a guaranteed-empty
        // round trip on every token exchange. Refresh picks the budget up once
        // one exists.

        // Signing is part of the transaction boundary. A key/configuration
        // failure must not consume the one-time code or persist unusable rows.
        const audience = authReq['audience'] as string | null | undefined;
        jwt = await withSpan('grantex.token.sign', {
          [GRANTEX_AGENT_ID]: authReq['agent_did'] as string,
          [GRANTEX_GRANT_ID]: grantId,
          [GRANTEX_PRINCIPAL_ID]: authReq['principal_id'] as string,
          [GRANTEX_DEVELOPER_ID]: developerId,
          [GRANTEX_SCOPES]: authReq['scopes'] as string[],
        }, () => signGrantToken({
          sub: authReq['principal_id'] as string,
          agt: authReq['agent_did'] as string,
          dev: authReq['developer_id'] as string,
          clientId: authReq['agent_id'] as string,
          scp: authReq['scopes'] as string[],
          jti,
          grnt: grantId,
          ...(audience ? { aud: audience } : {}),
          ...(typeof authReq['agent_key_thumbprint'] === 'string'
            ? { cnf: { jkt: authReq['agent_key_thumbprint'] } }
            : {}),
          exp: expTimestamp,
        }));

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

    // VC-JWT issuance (optional)
    let verifiableCredential: string | undefined;
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
    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reply.status(400).send({ message: 'Request body must be a JSON object', code: 'BAD_REQUEST', requestId: request.id });
    }
    const { refreshToken, agentId } = body;

    if (typeof refreshToken !== 'string' || refreshToken.length === 0 || refreshToken.length > 512
        || typeof agentId !== 'string' || agentId.length === 0 || agentId.length > 256) {
      return reply.status(400).send({
        message: 'refreshToken and agentId are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;
    const rawIdempotencyKey = request.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(rawIdempotencyKey) ? rawIdempotencyKey[0] : rawIdempotencyKey;
    if (idempotencyKey !== undefined && (idempotencyKey.length < 16 || idempotencyKey.length > 256)) {
      return reply.status(400).send({
        message: 'Idempotency-Key must contain 16 to 256 characters',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const replayRequestHash = idempotencyKey
      ? refreshReplayRequestHash(developerId, agentId, refreshToken, idempotencyKey)
      : null;

    let row!: Record<string, unknown>;
    let grantId!: string;
    let scopes!: string[];
    let grantExpiresAt!: Date;
    let jwt!: string;
    let jti = newTokenId();
    let issuedAt = Math.floor(Date.now() / 1000);
    let responseRefreshToken!: string;
    let refreshReplay = false;

    try {
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx`
          SELECT rt.id AS refresh_id, rt.grant_id, rt.is_used,
                 rt.expires_at AS refresh_expires_at, rt.used_at,
                  rt.rotated_to_token_id, rt.replay_expires_at,
                  rt.replay_request_hash, rt.replay_jti, rt.replay_issued_at,
                  rt.replay_grant_token,
                 g.agent_id, g.principal_id, g.developer_id, g.scopes, g.status AS grant_status,
                  g.expires_at AS grant_expires_at, g.audience, g.agent_key_thumbprint,
                 g.parent_grant_id, g.delegation_depth,
                 a.did AS agent_did, parent_agent.did AS parent_agent_did,
                  ba.remaining_budget, ba.currency AS budget_currency
          FROM refresh_tokens rt
          JOIN grants g ON g.id = rt.grant_id
          JOIN agents a ON a.id = g.agent_id
          LEFT JOIN grants parent_grant ON parent_grant.id = g.parent_grant_id
          LEFT JOIN agents parent_agent ON parent_agent.id = parent_grant.agent_id
          LEFT JOIN budget_allocations ba ON ba.grant_id = g.id
          WHERE rt.id = ${refreshToken}
            AND g.developer_id = ${developerId}
            AND a.status = 'active'
          FOR UPDATE OF rt, g, a
        `;

        row = rows[0] ?? routeError(400, 'Invalid refresh token');
        if (row['agent_id'] !== agentId) {
          routeError(400, 'Agent mismatch');
        }
        if (row['grant_status'] === 'revoked') {
          routeError(400, 'Grant has been revoked');
        }
        if (row['grant_status'] !== 'active') {
          routeError(400, 'Grant is not active');
        }
        if (new Date(row['grant_expires_at'] as string) <= new Date()) {
          routeError(400, 'Grant has expired');
        }

        grantId = row['grant_id'] as string;
        scopes = row['scopes'] as string[];
        grantExpiresAt = new Date(row['grant_expires_at'] as string);
        const now = new Date();
        // Refresh tokens cannot outlive the underlying grant.
        const refreshExpiresAt = new Date(Math.min(now.getTime() + 30 * 86400 * 1000, grantExpiresAt.getTime()));

        const remainingBudget = row['remaining_budget'];
        const remainingBudgetText = remainingBudget !== null && remainingBudget !== undefined
          ? String(remainingBudget)
          : undefined;
        const budgetAmount = remainingBudget !== null && remainingBudget !== undefined
          ? Number(remainingBudget)
          : undefined;
        if (budgetAmount !== undefined && !Number.isFinite(budgetAmount)) {
          routeError(500, 'Invalid budget allocation', 'INTERNAL_ERROR');
        }
        const budgetCurrency = typeof row['budget_currency'] === 'string' ? row['budget_currency'] : undefined;
        if (remainingBudgetText !== undefined
            && (!/^(0|[1-9]\d*)(\.\d+)?$/.test(remainingBudgetText)
              || !budgetCurrency
              || !/^[A-Z]{3}$/.test(budgetCurrency))) {
          routeError(500, 'Invalid budget allocation', 'INTERNAL_ERROR');
        }
        const audience = row['audience'] as string | null | undefined;
        const parentGrnt = row['parent_grant_id'] as string | null | undefined;
        const parentAgt = row['parent_agent_did'] as string | null | undefined;
        const delegationDepth = Number(row['delegation_depth'] ?? 0);

        const signRefreshedGrantToken = () => signGrantToken({
          sub: row['principal_id'] as string,
          agt: row['agent_did'] as string,
          dev: row['developer_id'] as string,
          clientId: row['agent_id'] as string,
          scp: scopes,
          jti,
          grnt: grantId,
          iat: issuedAt,
          ...(audience ? { aud: audience } : {}),
          ...(typeof row['agent_key_thumbprint'] === 'string'
            ? { cnf: { jkt: row['agent_key_thumbprint'] } }
            : {}),
          ...(budgetAmount !== undefined ? { bdg: budgetAmount } : {}),
          ...(remainingBudgetText !== undefined && budgetCurrency
            ? {
                authorizationDetails: [{
                  type: 'urn:grantex:params:oauth:authorization-details:budget',
                  amount: remainingBudgetText,
                  currency: budgetCurrency,
                }],
              }
            : {}),
          ...(parentAgt ? { parentAgt } : {}),
          ...(parentGrnt ? { parentGrnt } : {}),
          ...(parentAgt ? { act: { sub: parentAgt } } : {}),
          ...(delegationDepth > 0 ? { delegationDepth } : {}),
          exp: Math.floor(grantExpiresAt.getTime() / 1000),
        });

        if (row['is_used']) {
          const replayExpiresAt = row['replay_expires_at'] !== null && row['replay_expires_at'] !== undefined
            ? new Date(row['replay_expires_at'] as string)
            : null;
          const rotatedToTokenId = row['rotated_to_token_id'];
          if (
            typeof rotatedToTokenId !== 'string'
            || rotatedToTokenId.length === 0
            || replayExpiresAt === null
            || Number.isNaN(replayExpiresAt.getTime())
            || replayExpiresAt <= now
          ) {
            routeError(400, REFRESH_TOKEN_ALREADY_USED);
          }
          const replayIssuedAt = Number(row['replay_issued_at']);
          if (!replayHashMatches(row['replay_request_hash'], replayRequestHash)
              || typeof row['replay_jti'] !== 'string'
              || typeof row['replay_grant_token'] !== 'string'
              || row['replay_grant_token'].length === 0
              || !Number.isSafeInteger(replayIssuedAt)) {
            routeError(400, REFRESH_TOKEN_ALREADY_USED);
          }

          const rotatedRows = await tx`
            SELECT id, grant_id, is_used, expires_at
            FROM refresh_tokens
            WHERE id = ${rotatedToTokenId}
            FOR UPDATE
          `;
          const rotated = rotatedRows[0];
          if (
            !rotated
            || rotated['grant_id'] !== grantId
            || rotated['is_used']
            || new Date(rotated['expires_at'] as string) <= now
          ) {
            routeError(400, REFRESH_TOKEN_ALREADY_USED);
          }

          // The previous response may have been lost after commit. The same
          // idempotency key reproduces the original token identity and returns
          // the already-rotated child without extending any lifetime.
          responseRefreshToken = rotatedToTokenId;
          refreshReplay = true;
          jti = row['replay_jti'];
          issuedAt = replayIssuedAt;
          jwt = row['replay_grant_token'];
          return;
        }

        if (new Date(row['refresh_expires_at'] as string) < now) {
          routeError(400, 'Refresh token expired');
        }

        const newRefreshId = newRefreshTokenId();
        responseRefreshToken = newRefreshId;

        // Sign before rotating the single-use refresh token. A signer failure
        // rolls the transaction back and leaves the caller able to retry.
        jwt = await signRefreshedGrantToken();

        await tx`
          INSERT INTO refresh_tokens (id, grant_id, expires_at)
          VALUES (${newRefreshId}, ${grantId}, ${refreshExpiresAt})
        `;

        const updated = await tx`
          UPDATE refresh_tokens
          SET is_used = true,
              used_at = NOW(),
              rotated_to_token_id = ${newRefreshId},
              replay_request_hash = ${replayRequestHash},
              replay_jti = ${jti},
              replay_issued_at = ${issuedAt},
              replay_grant_token = ${jwt},
              replay_expires_at = LEAST(
                NOW() + (${REFRESH_TOKEN_REPLAY_WINDOW_SECONDS} * INTERVAL '1 second'),
                ${refreshExpiresAt}
              )
          WHERE id = ${row['refresh_id'] as string}
            AND is_used = false
          RETURNING id
        `;
        if (!updated[0]) {
          routeError(400, REFRESH_TOKEN_ALREADY_USED);
        }

        await tx`
          INSERT INTO grant_tokens (jti, grant_id, expires_at)
          VALUES (${jti}, ${grantId}, ${grantExpiresAt})
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

    // Emit event (best-effort)
    const eventData = {
      grantId,
      agentId: row['agent_id'] as string,
      principalId: row['principal_id'] as string,
      scopes,
      expiresAt: grantExpiresAt.toISOString(),
    };
    emitEvent(developerId, 'token.issued', { tokenId: jti, refreshReplay, ...eventData }).catch(() => {});

    return reply.status(201).send({
      grantToken: jwt,
      expiresAt: grantExpiresAt.toISOString(),
      scopes,
      refreshToken: responseRefreshToken,
      grantId,
    });
  });
}
