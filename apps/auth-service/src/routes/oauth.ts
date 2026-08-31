import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { config } from '../config.js';
import { checkActiveOAuthAccessToken } from '../lib/active-grant-token.js';
import { signOAuthAccessToken, verifyOAuthAccessToken } from '../lib/crypto.js';
import { DpopError, verifyDpopProof } from '../lib/dpop.js';
import {
  newAuthorizationCode,
  newAuthRequestId,
  newGrantId,
  newOAuthRefreshTokenId,
  newParRequestUri,
  newTokenId,
} from '../lib/ids.js';
import { isValidPkceChallenge, isValidPkceVerifier, verifyPkceChallenge } from '../lib/pkce.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import { getPolicyBackend } from '../lib/policy-backend.js';
import { openRefreshReplayToken, sealRefreshReplayToken } from '../lib/refresh-replay.js';

const OAUTH_PROTOCOL = 'oauth-agent-grants-03';
const PAR_LIFETIME_SECONDS = 90;
const AUTH_REQUEST_LIFETIME_SECONDS = 600;
const ACCESS_TOKEN_LIFETIME_SECONDS = 300;
const GRANT_LIFETIME_SECONDS = 86_400;
const RESOURCE_SCOPE = 'grantex.resource.read';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const REFRESH_REPLAY_WINDOW_SECONDS = 300;

type OAuthBody = Record<string, unknown>;

interface OAuthFailure {
  statusCode: number;
  error: string;
  description: string;
}

function oauthFailure(statusCode: number, error: string, description: string): never {
  throw { statusCode, error, description } satisfies OAuthFailure;
}

function isOAuthFailure(value: unknown): value is OAuthFailure {
  return typeof value === 'object'
    && value !== null
    && 'statusCode' in value
    && 'error' in value
    && 'description' in value;
}

function sendOAuthFailure(reply: FastifyReply, failure: OAuthFailure) {
  return reply.status(failure.statusCode).send({
    error: failure.error,
    error_description: failure.description,
  });
}

function single(body: OAuthBody, name: string): string | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') oauthFailure(400, 'invalid_request', `${name} must occur exactly once`);
  return value;
}

function required(body: OAuthBody, name: string): string {
  const value = single(body, name);
  if (!value) oauthFailure(400, 'invalid_request', `${name} is required`);
  return value;
}

function parseScopes(value: string): string[] {
  const scopes = value.split(' ');
  if (scopes.length === 0 || scopes.length > 100
      || value.startsWith(' ') || value.endsWith(' ') || value.includes('  ')
      || scopes.some((scope) => scope.length > 256
        || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
    oauthFailure(400, 'invalid_scope', 'scope must contain 1 to 100 space-delimited values');
  }
  if (new Set(scopes).size !== scopes.length) {
    oauthFailure(400, 'invalid_scope', 'scope must not contain duplicate values');
  }
  return scopes;
}

function dpopHeader(headers: Record<string, unknown>): string | undefined {
  const value = headers['dpop'];
  return typeof value === 'string' ? value : undefined;
}

function idempotencyKeyHeader(headers: Record<string, unknown>): string | undefined {
  const value = headers['idempotency-key'];
  if (Array.isArray(value)) oauthFailure(400, 'invalid_request', 'Idempotency-Key must occur exactly once');
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) {
    oauthFailure(400, 'invalid_request', 'Idempotency-Key must contain 16 to 256 characters');
  }
  return value;
}

function refreshReplayRequestHash(
  clientId: string,
  refreshToken: string,
  keyThumbprint: string,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`grantex-oauth-refresh-replay:v1\0${clientId}\0${refreshToken}\0${keyThumbprint}\0${idempotencyKey}`)
    .digest('hex');
}

function replayHashMatches(stored: unknown, candidate: string | null): boolean {
  if (typeof stored !== 'string' || stored.length !== 64 || candidate === null || candidate.length !== 64) {
    return false;
  }
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(candidate, 'hex'));
}

function endpoint(path: string): string {
  return `${config.publicBaseUrl.replace(/\/$/, '')}${path}`;
}

function issuer(): string {
  return config.jwtIssuer.replace(/\/$/, '');
}

function redirectUriWithParams(uri: string, params: Record<string, string>): string {
  const target = new URL(uri);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

async function requireGrantCapacity(tx: TxSql, developerId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 3))`;
  const rows = await tx`
    SELECT
      COALESCE((SELECT plan FROM subscriptions WHERE developer_id = ${developerId} LIMIT 1), 'free') AS plan,
      (SELECT COUNT(*) FROM grants
       WHERE developer_id = ${developerId} AND status = 'active' AND expires_at > NOW()) AS count
  `;
  const planName = (rows[0]?.['plan'] as string | undefined) ?? 'free';
  const plan = isPlanName(planName) ? planName : 'free';
  const count = Number(rows[0]?.['count'] ?? 0);
  if (!Number.isSafeInteger(count) || count >= PLAN_LIMITS[plan].grants) {
    oauthFailure(402, 'temporarily_unavailable', 'The client grant limit has been reached');
  }
}

function validState(value: string): boolean {
  return value.length >= 22 && value.length <= 1024 && /^[A-Za-z0-9._~-]+$/.test(value);
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const parsed: Record<string, string | string[]> = {};
        const encoded = typeof body === 'string' ? body : body.toString('utf8');
        for (const [key, value] of new URLSearchParams(encoded)) {
          const current = parsed[key];
          if (current === undefined) parsed[key] = value;
          else if (Array.isArray(current)) current.push(value);
          else parsed[key] = [current, value];
        }
        done(null, parsed);
      } catch (error) {
        done(error instanceof Error ? error : new Error('Invalid form body'));
      }
    },
  );

  app.post<{ Body: OAuthBody }>(
    '/oauth/par',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const clientId = required(body, 'client_id');
        const redirectUri = required(body, 'redirect_uri');
        const state = required(body, 'state');
        const codeChallenge = required(body, 'code_challenge');
        const resource = required(body, 'resource');
        const requestedPrincipalHint = single(body, 'login_hint');
        const dpopJktParameter = single(body, 'dpop_jkt');
        const scopes = parseScopes(required(body, 'scope'));

        if (required(body, 'response_type') !== 'code') {
          oauthFailure(400, 'unsupported_response_type', 'Only response_type=code is supported');
        }
        if (required(body, 'code_challenge_method') !== 'S256' || !isValidPkceChallenge(codeChallenge)) {
          oauthFailure(400, 'invalid_request', 'PKCE S256 with a valid code_challenge is required');
        }
        if (!validState(state)) {
          oauthFailure(400, 'invalid_request', 'state must carry at least 128 bits in 22 or more URL-safe characters');
        }
        if (requestedPrincipalHint !== undefined
            && (requestedPrincipalHint.length === 0 || requestedPrincipalHint.length > 256)) {
          oauthFailure(400, 'invalid_request', 'login_hint must contain 1 to 256 characters when present');
        }

        let parsedResource: URL;
        try {
          parsedResource = new URL(resource);
        } catch {
          oauthFailure(400, 'invalid_target', 'resource must be an absolute URI');
        }
        if (parsedResource.hash || !['https:', ...(process.env.NODE_ENV !== 'production' ? ['http:'] : [])].includes(parsedResource.protocol)) {
          oauthFailure(400, 'invalid_target', 'resource must be an allowed absolute URI without a fragment');
        }

        const sql = getSql();
        const agentRows = await sql`
          SELECT a.id, a.developer_id, a.scopes, a.redirect_uris, a.resource_servers,
                 a.key_thumbprint, a.key_verified_thumbprint, a.status, d.mode
          FROM agents a
          JOIN developers d ON d.id = a.developer_id
          WHERE a.id = ${clientId}
        `;
        const agent = agentRows[0];
        if (!agent || agent['status'] !== 'active') {
          oauthFailure(400, 'invalid_request', 'Unknown or inactive client_id');
        }
        if (!(agent['redirect_uris'] as string[]).includes(redirectUri)) {
          oauthFailure(400, 'invalid_request', 'redirect_uri does not exactly match the client registration');
        }
        if (!(agent['resource_servers'] as string[]).includes(resource)) {
          oauthFailure(400, 'invalid_target', 'resource is not registered for this client');
        }
        const registeredScopes = agent['scopes'] as string[];
        if (scopes.some((scope) => !registeredScopes.includes(scope))) {
          oauthFailure(400, 'invalid_scope', 'Requested scope exceeds the client registration');
        }
        const registeredThumbprint = agent['key_thumbprint'];
        if (typeof registeredThumbprint !== 'string' || registeredThumbprint.length === 0) {
          oauthFailure(400, 'invalid_request', 'The client has no registered Agent Key');
        }
        const principalHint = requestedPrincipalHint
          ?? (agent['mode'] === 'sandbox' ? `sandbox:${clientId}` : null);

        const proofValue = dpopHeader(request.headers);
        let proofThumbprint: string | undefined;
        if (proofValue !== undefined) {
          const proof = await verifyDpopProof(proofValue, {
            method: 'POST',
            targetUri: endpoint('/oauth/par'),
          });
          proofThumbprint = proof.thumbprint;
        }
        if (!dpopJktParameter && !proofThumbprint) {
          oauthFailure(400, 'invalid_dpop_proof', 'dpop_jkt or a DPoP proof is required');
        }
        if (dpopJktParameter && proofThumbprint && dpopJktParameter !== proofThumbprint) {
          oauthFailure(400, 'invalid_dpop_proof', 'dpop_jkt does not match the DPoP proof key');
        }
        const boundThumbprint = proofThumbprint ?? dpopJktParameter!;
        if (boundThumbprint !== registeredThumbprint) {
          oauthFailure(400, 'invalid_dpop_proof', 'The DPoP key is not registered for this client');
        }
        if (!proofThumbprint && agent['key_verified_thumbprint'] !== boundThumbprint) {
          oauthFailure(400, 'invalid_dpop_proof', 'dpop_jkt requires prior proof of possession for the registered key');
        }
        if (proofThumbprint) {
          await sql`
            UPDATE agents
            SET key_verified_thumbprint = ${proofThumbprint}, key_verified_at = NOW()
            WHERE id = ${clientId} AND key_thumbprint = ${proofThumbprint}
          `;
        }

        let authorizationDetails: unknown = null;
        const rawAuthorizationDetails = single(body, 'authorization_details');
        if (rawAuthorizationDetails !== undefined) {
          try {
            authorizationDetails = JSON.parse(rawAuthorizationDetails);
          } catch {
            oauthFailure(400, 'invalid_request', 'authorization_details must be valid JSON');
          }
          if (!Array.isArray(authorizationDetails)
              || authorizationDetails.length === 0
              || authorizationDetails.length > 20
              || authorizationDetails.some((detail) => !detail
                || typeof detail !== 'object'
                || Array.isArray(detail)
                || typeof (detail as Record<string, unknown>)['type'] !== 'string'
                || ((detail as Record<string, unknown>)['type'] as string).length === 0
                || ((detail as Record<string, unknown>)['type'] as string).length > 128)) {
            oauthFailure(400, 'invalid_request', 'authorization_details must contain 1 to 20 typed JSON objects');
          }
        }

        const requestUri = newParRequestUri();
        const expiresAt = new Date(Date.now() + PAR_LIFETIME_SECONDS * 1000);
        await sql`
          INSERT INTO oauth_par_requests (
            request_uri, client_id, developer_id, redirect_uri, scopes, state,
            code_challenge, resource, dpop_jkt, principal_hint,
            authorization_details, expires_at
          )
          VALUES (
            ${requestUri}, ${clientId}, ${agent['developer_id'] as string},
            ${redirectUri}, ${scopes}, ${state}, ${codeChallenge}, ${resource},
            ${boundThumbprint}, ${principalHint},
            ${authorizationDetails === null ? null : sql.json(authorizationDetails as never)}, ${expiresAt}
          )
        `;

        return reply.status(201).send({ request_uri: requestUri, expires_in: PAR_LIFETIME_SECONDS });
      } catch (error) {
        if (error instanceof DpopError) {
          return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_dpop_proof', description: error.message });
        }
        if (isOAuthFailure(error)) return sendOAuthFailure(reply, error);
        throw error;
      }
    },
  );

  app.get<{ Querystring: { client_id?: string | string[]; request_uri?: string | string[] } }>(
    '/oauth/authorize',
    { config: { skipAuth: true, rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const clientId = request.query.client_id;
      const requestUri = request.query.request_uri;
      if (typeof clientId !== 'string' || typeof requestUri !== 'string'
          || clientId.length === 0 || requestUri.length === 0) {
        return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_request', description: 'client_id and request_uri are required' });
      }

      const sql = getSql();
      const rows = await sql`
        SELECT p.*, a.name AS agent_name, d.mode
        FROM oauth_par_requests p
        JOIN agents a ON a.id = p.client_id
        JOIN developers d ON d.id = p.developer_id
        WHERE p.request_uri = ${requestUri} AND p.client_id = ${clientId}
      `;
      const par = rows[0];
      if (!par || par['status'] !== 'pushed' || new Date(par['expires_at'] as string) <= new Date()) {
        return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_request_uri', description: 'The pushed request is unknown, expired, consumed, or belongs to another client' });
      }

      const policyDecision = await getPolicyBackend().evaluate({
        agentId: clientId,
        principalId: (par['principal_hint'] as string | null) ?? '',
        scopes: par['scopes'] as string[],
        developerId: par['developer_id'] as string,
      });
      if (policyDecision.effect === 'deny') {
        const deniedRows = await sql`
          UPDATE oauth_par_requests
          SET status = 'denied'
          WHERE request_uri = ${requestUri} AND client_id = ${clientId} AND status = 'pushed'
          RETURNING request_uri
        `;
        if (!deniedRows[0]) {
          return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_request_uri', description: 'The pushed request has already been consumed' });
        }
        const target = redirectUriWithParams(par['redirect_uri'] as string, {
          error: 'access_denied',
          state: par['state'] as string,
          iss: issuer(),
        });
        return reply.redirect(target, 303);
      }

      const authRequestId = newAuthRequestId();
      const code = par['mode'] === 'sandbox' ? newAuthorizationCode() : null;
      const authExpiresAt = new Date(Date.now() + AUTH_REQUEST_LIFETIME_SECONDS * 1000);
      let claimed = false;
      await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const claimedRows = await tx`
          UPDATE oauth_par_requests
          SET status = 'consumed'
          WHERE request_uri = ${requestUri}
            AND client_id = ${clientId}
            AND status = 'pushed'
            AND expires_at > NOW()
          RETURNING request_uri
        `;
        if (!claimedRows[0]) return;
        claimed = true;
        await tx`
          INSERT INTO auth_requests (
            id, agent_id, principal_id, developer_id, scopes, redirect_uri,
            state, expires_in, expires_at, audience, status, code,
            code_challenge, code_challenge_method, agent_key_thumbprint,
            protocol, authorization_details
          )
          VALUES (
            ${authRequestId}, ${clientId}, ${(par['principal_hint'] as string | null) ?? ''},
            ${par['developer_id'] as string}, ${par['scopes'] as string[]},
            ${par['redirect_uri'] as string}, ${par['state'] as string},
            '24h', ${authExpiresAt}, ${par['resource'] as string},
            ${par['mode'] === 'sandbox' ? 'approved' : 'pending'}, ${code},
            ${par['code_challenge'] as string}, 'S256', ${par['dpop_jkt'] as string},
            ${OAUTH_PROTOCOL},
            ${par['authorization_details'] === null || par['authorization_details'] === undefined
              ? null
              : tx.json(par['authorization_details'] as never)}
          )
        `;
      });

      if (!claimed) {
        return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_request_uri', description: 'The pushed request has already been consumed' });
      }
      if (code) {
        return reply.redirect(redirectUriWithParams(par['redirect_uri'] as string, {
          code,
          state: par['state'] as string,
          iss: issuer(),
        }), 303);
      }
      return reply.redirect(`${config.publicBaseUrl.replace(/\/$/, '')}/consent?req=${encodeURIComponent(authRequestId)}`, 303);
    },
  );

  app.post<{ Body: OAuthBody }>(
    '/oauth/token',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
      try {
        const grantType = required(request.body ?? {}, 'grant_type');
        if (grantType === 'authorization_code') {
          return await authorizationCodeToken(request.body, request.headers, reply);
        }
        if (grantType === 'refresh_token') {
          return await refreshToken(request.body, request.headers, reply);
        }
        if (grantType === TOKEN_EXCHANGE_GRANT) {
          return await exchangeToken(request.body, request.headers, reply);
        }
        oauthFailure(400, 'unsupported_grant_type', 'The requested grant type is not supported');
      } catch (error) {
        if (error instanceof DpopError) {
          return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_dpop_proof', description: error.message });
        }
        if (isOAuthFailure(error)) return sendOAuthFailure(reply, error);
        throw error;
      }
    },
  );

  app.post<{ Body: OAuthBody }>(
    '/oauth/revoke',
    { config: { skipAuth: true, rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const body = request.body ?? {};
        const clientId = required(body, 'client_id');
        const token = required(body, 'token');
        const proof = await verifyDpopProof(dpopHeader(request.headers), {
          method: 'POST',
          targetUri: endpoint('/oauth/revoke'),
        });
        const sql = getSql();
        const agentRows = await sql`
          SELECT id, developer_id, key_thumbprint
          FROM agents
          WHERE id = ${clientId} AND status = 'active'
        `;
        const agent = agentRows[0];
        if (!agent || agent['key_thumbprint'] !== proof.thumbprint) {
          oauthFailure(401, 'invalid_client', 'Client authentication failed');
        }

        if (token.startsWith('ref_')) {
          const refreshRows = await sql`
            SELECT COALESCE(rt.family_id, rt.id) AS family_id
            FROM refresh_tokens rt
            JOIN grants g ON g.id = rt.grant_id
            WHERE rt.id = ${token}
              AND g.agent_id = ${clientId}
              AND g.developer_id = ${agent['developer_id'] as string}
              AND g.protocol = ${OAUTH_PROTOCOL}
          `;
          if (refreshRows[0]) {
            await sql`
              UPDATE refresh_tokens
              SET is_used = TRUE, used_at = COALESCE(used_at, NOW())
              WHERE COALESCE(family_id, id) = ${refreshRows[0]['family_id'] as string}
            `;
          }
          return reply.status(200).send();
        }

        try {
          const claims = await verifyOAuthAccessToken(token);
          if (claims.clientId === clientId && claims.cnf?.jkt === proof.thumbprint) {
            const revoked = await sql`
              UPDATE grant_tokens gt
              SET is_revoked = TRUE
              FROM grants g
              WHERE gt.jti = ${claims.jti}
                AND gt.grant_id = g.id
                AND g.agent_id = ${clientId}
                AND g.developer_id = ${agent['developer_id'] as string}
                AND g.protocol = ${OAUTH_PROTOCOL}
              RETURNING gt.expires_at
            `;
            if (revoked[0]) {
              const ttl = Math.max(1, Math.floor((new Date(revoked[0]['expires_at'] as string).getTime() - Date.now()) / 1000));
              await getRedis().set(`revoked:tok:${claims.jti}`, '1', 'EX', ttl);
            }
          }
        } catch {
          // RFC 7009 deliberately does not reveal whether the token was valid.
        }
        return reply.status(200).send();
      } catch (error) {
        if (error instanceof DpopError) {
          return sendOAuthFailure(reply, { statusCode: 400, error: 'invalid_dpop_proof', description: error.message });
        }
        if (isOAuthFailure(error)) return sendOAuthFailure(reply, error);
        throw error;
      }
    },
  );

  app.all(
    '/oauth/resource',
    { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const authorization = request.headers.authorization;
      const match = typeof authorization === 'string' ? /^DPoP[ \t]+([^\s]+)$/.exec(authorization) : null;
      if (!match) {
        reply.header('WWW-Authenticate', 'DPoP error="invalid_token"');
        return sendOAuthFailure(reply, { statusCode: 401, error: 'invalid_token', description: 'Use the DPoP authorization scheme' });
      }
      const accessToken = match[1]!;
      try {
        const proof = await verifyDpopProof(dpopHeader(request.headers), {
          method: request.method,
          targetUri: endpoint('/oauth/resource'),
          accessToken,
        });
        const checked = await checkActiveOAuthAccessToken(accessToken, OAUTH_PROTOCOL);
        if (!checked.ok) oauthFailure(401, 'invalid_token', 'The access token is invalid, expired, or revoked');
        const claims = checked.claims;
        if (claims.aud !== endpoint('/oauth/resource')) {
          oauthFailure(401, 'invalid_token', 'The access token audience does not identify this resource');
        }
        if (claims.cnf?.jkt !== proof.thumbprint) {
          oauthFailure(401, 'invalid_token', 'The DPoP key does not match the access token binding');
        }
        if (!claims.scopes.includes(RESOURCE_SCOPE)) {
          reply.header('WWW-Authenticate', `DPoP error="insufficient_scope", scope="${RESOURCE_SCOPE}"`);
          oauthFailure(403, 'insufficient_scope', `The ${RESOURCE_SCOPE} scope is required`);
        }
        return reply.send({
          subject: claims.sub,
          client_id: claims.clientId,
          scope: claims.scope,
          authorized: true,
        });
      } catch (error) {
        if (error instanceof DpopError) {
          reply.header('WWW-Authenticate', 'DPoP error="invalid_dpop_proof"');
          return sendOAuthFailure(reply, { statusCode: 401, error: 'invalid_dpop_proof', description: error.message });
        }
        if (isOAuthFailure(error)) return sendOAuthFailure(reply, error);
        throw error;
      }
    },
  );
}

async function authorizationCodeToken(
  body: OAuthBody,
  headers: Record<string, unknown>,
  reply: FastifyReply,
) {
  const code = required(body, 'code');
  const clientId = required(body, 'client_id');
  const redirectUri = required(body, 'redirect_uri');
  const codeVerifier = required(body, 'code_verifier');
  if (!isValidPkceVerifier(codeVerifier)) oauthFailure(400, 'invalid_grant', 'The PKCE verifier is invalid');
  const proof = await verifyDpopProof(dpopHeader(headers), { method: 'POST', targetUri: endpoint('/oauth/token') });

  const sql = getSql();
  const now = Date.now();
  const grantId = newGrantId();
  const jti = newTokenId();
  const refreshId = newOAuthRefreshTokenId();
  const grantExpiresAt = new Date(now + GRANT_LIFETIME_SECONDS * 1000);
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_LIFETIME_SECONDS * 1000);
  let jwt = '';
  let scopes: string[] = [];

  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      SELECT ar.*, a.did AS agent_did, a.status AS agent_status, a.key_thumbprint
      FROM auth_requests ar
      JOIN agents a ON a.id = ar.agent_id
      WHERE ar.code = ${code}
        AND ar.agent_id = ${clientId}
        AND ar.protocol = ${OAUTH_PROTOCOL}
      FOR UPDATE OF ar, a
    `;
    const auth = rows[0];
    if (!auth || auth['status'] !== 'approved' || new Date(auth['expires_at'] as string) <= new Date()) {
      oauthFailure(400, 'invalid_grant', 'The authorization code is invalid, expired, or already used');
    }
    if (auth['agent_status'] !== 'active' || auth['redirect_uri'] !== redirectUri) {
      oauthFailure(400, 'invalid_grant', 'The client or redirect URI does not match the authorization code');
    }
    if (!verifyPkceChallenge(codeVerifier, auth['code_challenge'] as string)) {
      oauthFailure(400, 'invalid_grant', 'The PKCE verifier does not match the authorization request');
    }
    if (auth['agent_key_thumbprint'] !== proof.thumbprint || auth['key_thumbprint'] !== proof.thumbprint) {
      oauthFailure(400, 'invalid_dpop_proof', 'The token proof key does not match the PAR binding');
    }
    if (typeof auth['audience'] !== 'string' || auth['audience'].length === 0) {
      oauthFailure(400, 'invalid_target', 'The authorization has no resource binding');
    }

    await requireGrantCapacity(tx, auth['developer_id'] as string);
    scopes = auth['scopes'] as string[];
    jwt = await signOAuthAccessToken({
      sub: auth['principal_id'] as string,
      clientId,
      scopes,
      jti,
      aud: auth['audience'] as string,
      cnf: { jkt: proof.thumbprint },
      ...(Array.isArray(auth['authorization_details'])
        ? { authorizationDetails: auth['authorization_details'] as Array<Record<string, unknown>> }
        : {}),
      exp: Math.floor(accessExpiresAt.getTime() / 1000),
    });

    await tx`
      INSERT INTO grants (
        id, agent_id, principal_id, developer_id, scopes, expires_at,
        audience, agent_key_thumbprint, protocol, authorization_details
      )
      VALUES (
        ${grantId}, ${clientId}, ${auth['principal_id'] as string},
        ${auth['developer_id'] as string}, ${scopes}, ${grantExpiresAt},
        ${auth['audience'] as string}, ${proof.thumbprint}, ${OAUTH_PROTOCOL},
        ${auth['authorization_details'] === null || auth['authorization_details'] === undefined
          ? null
          : tx.json(auth['authorization_details'] as never)}
      )
    `;
    await tx`INSERT INTO grant_tokens (jti, grant_id, expires_at) VALUES (${jti}, ${grantId}, ${accessExpiresAt})`;
    await tx`
      INSERT INTO refresh_tokens (id, grant_id, expires_at, family_id)
      VALUES (${refreshId}, ${grantId}, ${grantExpiresAt}, ${refreshId})
    `;
    const consumed = await tx`
      UPDATE auth_requests SET status = 'consumed'
      WHERE id = ${auth['id'] as string} AND status = 'approved'
      RETURNING id
    `;
    if (!consumed[0]) oauthFailure(400, 'invalid_grant', 'The authorization code has already been used');
  });

  return reply.status(200).send({
    access_token: jwt,
    token_type: 'DPoP',
    expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
    refresh_token: refreshId,
    scope: scopes.join(' '),
  });
}

async function refreshToken(body: OAuthBody, headers: Record<string, unknown>, reply: FastifyReply) {
  const refreshId = required(body, 'refresh_token');
  const clientId = required(body, 'client_id');
  const proof = await verifyDpopProof(dpopHeader(headers), { method: 'POST', targetUri: endpoint('/oauth/token') });
  const idempotencyKey = idempotencyKeyHeader(headers);
  const replayRequestHash = idempotencyKey
    ? refreshReplayRequestHash(clientId, refreshId, proof.thumbprint, idempotencyKey)
    : null;
  const sql = getSql();
  let responseRefreshId = newOAuthRefreshTokenId();
  const jti = newTokenId();
  let jwt = '';
  let scopes: string[] = [];
  let expiresIn = 0;
  let replayDetected = false;
  let refreshReplay = false;

  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      SELECT rt.id, rt.is_used, rt.expires_at AS refresh_expires_at,
             rt.used_at, rt.rotated_to_token_id, rt.replay_expires_at,
             rt.replay_request_hash, rt.replay_jti, rt.replay_issued_at,
             rt.replay_grant_token,
             COALESCE(rt.family_id, rt.id) AS family_id,
             g.id AS grant_id, g.agent_id, g.principal_id, g.developer_id,
             g.scopes, g.status, g.expires_at AS grant_expires_at, g.audience,
             g.agent_key_thumbprint, g.protocol, g.authorization_details,
             a.did AS agent_did,
             a.status AS agent_status, a.key_thumbprint AS current_key_thumbprint
      FROM refresh_tokens rt
      JOIN grants g ON g.id = rt.grant_id
      JOIN agents a ON a.id = g.agent_id
      WHERE rt.id = ${refreshId}
      FOR UPDATE OF rt, g, a
    `;
    const row = rows[0];
    if (!row || row['protocol'] !== OAUTH_PROTOCOL || row['agent_id'] !== clientId) {
      oauthFailure(400, 'invalid_grant', 'The refresh token is invalid');
    }
    if (row['agent_key_thumbprint'] !== proof.thumbprint
        || row['current_key_thumbprint'] !== proof.thumbprint) {
      oauthFailure(400, 'invalid_dpop_proof', 'The refresh proof key does not match the token family');
    }
    if (row['is_used']) {
      const now = new Date();
      const replayExpiresAt = row['replay_expires_at'] !== null && row['replay_expires_at'] !== undefined
        ? new Date(row['replay_expires_at'] as string)
        : null;
      const rotatedToTokenId = row['rotated_to_token_id'];
      const replayIssuedAt = Number(row['replay_issued_at']);
      const replayGrantToken = openRefreshReplayToken(row['replay_grant_token']);
      if (
        typeof rotatedToTokenId === 'string'
        && rotatedToTokenId.length > 0
        && replayExpiresAt !== null
        && !Number.isNaN(replayExpiresAt.getTime())
        && replayExpiresAt > now
        && replayHashMatches(row['replay_request_hash'], replayRequestHash)
        && typeof row['replay_jti'] === 'string'
        && replayGrantToken !== null
        && Number.isSafeInteger(replayIssuedAt)
      ) {
        const rotatedRows = await tx`
          SELECT id, grant_id, is_used, expires_at
          FROM refresh_tokens
          WHERE id = ${rotatedToTokenId}
          FOR UPDATE
        `;
        const rotated = rotatedRows[0];
        if (rotated
            && rotated['grant_id'] === row['grant_id']
            && !rotated['is_used']
            && new Date(rotated['expires_at'] as string) > now) {
          const originalAccessExpiry = Math.min(
            replayIssuedAt + ACCESS_TOKEN_LIFETIME_SECONDS,
            Math.floor(new Date(row['grant_expires_at'] as string).getTime() / 1000),
          );
          expiresIn = Math.max(1, originalAccessExpiry - Math.floor(now.getTime() / 1000));
          scopes = row['scopes'] as string[];
          responseRefreshId = rotatedToTokenId;
          jwt = replayGrantToken;
          refreshReplay = true;
          return;
        }
      }

      replayDetected = true;
      await tx`
        UPDATE refresh_tokens
        SET is_used = TRUE,
            used_at = COALESCE(used_at, NOW()),
            replay_expires_at = NULL,
            replay_request_hash = NULL,
            replay_jti = NULL,
            replay_issued_at = NULL,
            replay_grant_token = NULL
        WHERE COALESCE(family_id, id) = ${row['family_id'] as string}
      `;
      await tx`
        UPDATE grants SET status = 'revoked', revoked_at = NOW()
        WHERE id = ${row['grant_id'] as string} AND status = 'active'
      `;
      return;
    }
    const now = new Date();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const grantExpiresAt = new Date(row['grant_expires_at'] as string);
    if (row['status'] !== 'active' || row['agent_status'] !== 'active'
        || new Date(row['refresh_expires_at'] as string) <= now || grantExpiresAt <= now) {
      oauthFailure(400, 'invalid_grant', 'The refresh token or grant has expired or been revoked');
    }
    const accessExpiresAt = new Date(Math.min(now.getTime() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000, grantExpiresAt.getTime()));
    expiresIn = Math.max(1, Math.floor((accessExpiresAt.getTime() - now.getTime()) / 1000));
    scopes = row['scopes'] as string[];
    jwt = await signOAuthAccessToken({
      sub: row['principal_id'] as string,
      clientId,
      scopes,
      jti,
      aud: row['audience'] as string,
      cnf: { jkt: proof.thumbprint },
      iat: issuedAt,
      ...(Array.isArray(row['authorization_details'])
        ? { authorizationDetails: row['authorization_details'] as Array<Record<string, unknown>> }
        : {}),
      exp: Math.floor(accessExpiresAt.getTime() / 1000),
    });
    const encryptedReplayToken = sealRefreshReplayToken(jwt);
    await tx`
      INSERT INTO refresh_tokens (id, grant_id, expires_at, family_id, parent_token_id)
      VALUES (
        ${responseRefreshId}, ${row['grant_id'] as string}, ${grantExpiresAt},
        ${row['family_id'] as string}, ${refreshId}
      )
    `;
    const rotated = await tx`
      UPDATE refresh_tokens
      SET is_used = TRUE,
          used_at = NOW(),
          rotated_to_token_id = ${responseRefreshId},
          replay_request_hash = ${replayRequestHash},
          replay_jti = ${jti},
          replay_issued_at = ${issuedAt},
          replay_grant_token = ${encryptedReplayToken},
          replay_expires_at = LEAST(
            NOW() + (${REFRESH_REPLAY_WINDOW_SECONDS} * INTERVAL '1 second'),
            ${grantExpiresAt}
          )
      WHERE id = ${refreshId} AND is_used = FALSE
      RETURNING id
    `;
    if (!rotated[0]) oauthFailure(400, 'invalid_grant', 'The refresh token has already been used');
    await tx`
      INSERT INTO grant_tokens (jti, grant_id, expires_at)
      VALUES (${jti}, ${row['grant_id'] as string}, ${accessExpiresAt})
    `;
  });

  if (replayDetected) oauthFailure(400, 'invalid_grant', 'Refresh-token reuse revoked the token family');
  return reply.status(200).send({
    access_token: jwt,
    token_type: 'DPoP',
    expires_in: expiresIn,
    refresh_token: responseRefreshId,
    scope: scopes.join(' '),
    ...(refreshReplay ? { refresh_replay: true } : {}),
  });
}

async function exchangeToken(body: OAuthBody, headers: Record<string, unknown>, reply: FastifyReply) {
  const clientId = required(body, 'client_id');
  const subjectToken = required(body, 'subject_token');
  const resource = required(body, 'resource');
  const scopes = parseScopes(required(body, 'scope'));
  if (required(body, 'subject_token_type') !== ACCESS_TOKEN_TYPE
      || required(body, 'requested_token_type') !== ACCESS_TOKEN_TYPE) {
    oauthFailure(400, 'invalid_request', 'Only access-token input and output are supported');
  }
  if (single(body, 'actor_token') !== undefined || single(body, 'actor_token_type') !== undefined) {
    oauthFailure(400, 'invalid_request', 'Cross-instance actor tokens are outside this profile');
  }
  const proof = await verifyDpopProof(dpopHeader(headers), { method: 'POST', targetUri: endpoint('/oauth/token') });
  const checked = await checkActiveOAuthAccessToken(subjectToken, OAUTH_PROTOCOL);
  if (!checked.ok) oauthFailure(400, 'invalid_grant', 'The subject token is invalid, expired, or revoked');
  const claims = checked.claims;
  if (claims.clientId !== clientId || claims.cnf?.jkt !== proof.thumbprint) {
    oauthFailure(400, 'invalid_grant', 'The subject token does not belong to this client and sender key');
  }
  if (typeof claims.aud !== 'string' || claims.aud !== resource) {
    oauthFailure(400, 'invalid_target', 'resource must exactly match the subject token audience');
  }
  if (scopes.some((scope) => !claims.scopes.includes(scope))) {
    oauthFailure(400, 'invalid_scope', 'The exchanged scope must be a subset of the subject token scope');
  }

  const sql = getSql();
  const agentRows = await sql`
    SELECT id, developer_id, did, key_thumbprint, status
    FROM agents
    WHERE id = ${clientId}
  `;
  const agent = agentRows[0];
  if (!agent || agent['status'] !== 'active' || agent['key_thumbprint'] !== proof.thumbprint) {
    oauthFailure(401, 'invalid_client', 'Client authentication failed');
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(claims.exp, now + ACCESS_TOKEN_LIFETIME_SECONDS);
  if (exp <= now) oauthFailure(400, 'invalid_grant', 'The subject token has expired');
  const jti = newTokenId();
  const jwt = await signOAuthAccessToken({
    sub: claims.sub,
    clientId,
    scopes,
    jti,
    aud: resource,
    cnf: { jkt: proof.thumbprint },
    ...(claims.act ? { act: claims.act } : {}),
    ...(claims.authorizationDetails
      ? { authorizationDetails: claims.authorizationDetails }
      : {}),
    exp,
  });
  await sql`
    INSERT INTO grant_tokens (jti, grant_id, expires_at)
    VALUES (${jti}, ${checked.grantId}, ${new Date(exp * 1000)})
  `;
  return reply.status(200).send({
    access_token: jwt,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: 'DPoP',
    expires_in: exp - now,
    scope: scopes.join(' '),
  });
}
