import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAuthRequestId } from '../lib/ids.js';
import { config } from '../config.js';
import { ulid } from 'ulid';
import { getPolicyBackend } from '../lib/policy-backend.js';
import { isPlanName, PLAN_LIMITS } from '../lib/plans.js';
import { authorizeTotal, authorizeDuration } from '../lib/metrics.js';
import { incrementUsage } from '../lib/usage.js';
import { parseExpiresIn } from '../lib/crypto.js';
import { checkRateLimit } from '../lib/rate-limit.js';

const AUTHORIZE_MAX_PER_MINUTE = 10;
const AUTHORIZE_WINDOW_SECONDS = 60;

interface AuthorizeBody {
  agentId: string;
  principalId: string;
  scopes: string[];
  redirectUri?: string;
  state?: string;
  expiresIn?: string;
  audience?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export async function authorizeRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/authorize — per-developer rate limit of 10/min.
  // Keyed on developer.id (post-auth) instead of IP so that multiple developers
  // sharing a NAT'd egress IP — and our own CI running many suites from one
  // runner IP — don't share a bucket. The global IP-keyed limit in server.ts
  // still caps unauthenticated abuse.
  app.post<{ Body: AuthorizeBody }>('/v1/authorize', async (request, reply) => {
    const endTimer = authorizeDuration.startTimer();
    const { agentId, principalId, scopes, redirectUri, state, expiresIn = '24h', audience, codeChallenge, codeChallengeMethod } = request.body;

    const rl = await checkRateLimit(
      `authorize:${request.developer.id}`,
      AUTHORIZE_MAX_PER_MINUTE,
      AUTHORIZE_WINDOW_SECONDS,
    );
    if (!rl.allowed) {
      reply.header('retry-after', String(rl.resetSeconds));
      reply.header('x-ratelimit-limit', String(AUTHORIZE_MAX_PER_MINUTE));
      reply.header('x-ratelimit-remaining', '0');
      reply.header('x-ratelimit-reset', String(rl.resetSeconds));
      return reply.status(429).send({
        message: `Rate limit exceeded, retry in ${rl.resetSeconds} seconds`,
        code: 'RATE_LIMITED',
        requestId: request.id,
      });
    }

    if (!agentId || !principalId || !scopes?.length) {
      return reply.status(400).send({
        message: 'agentId, principalId, and scopes are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    if (scopes.some(s => typeof s !== 'string' || s.length > 256 || s.length === 0)) {
      return reply.status(400).send({ message: 'Invalid scope format', code: 'BAD_REQUEST', requestId: request.id });
    }
    if (scopes.length > 100) {
      return reply.status(400).send({ message: 'Too many scopes (max 100)', code: 'BAD_REQUEST', requestId: request.id });
    }

    // Validate PKCE params — only S256 is supported
    if (codeChallenge && codeChallengeMethod !== 'S256') {
      return reply.status(400).send({
        message: 'codeChallengeMethod must be S256',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Enforce plan grant limit
    const subRows = await sql<{ plan: string }[]>`
      SELECT plan FROM subscriptions WHERE developer_id = ${developerId}
    `;
    const planName = subRows[0]?.plan ?? 'free';
    const plan = isPlanName(planName) ? planName : 'free';
    const grantLimit = PLAN_LIMITS[plan].grants;

    const countRows = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM grants
      WHERE developer_id = ${developerId}
        AND status = 'active'
        AND expires_at > NOW()
    `;
    const grantCount = parseInt(countRows[0]?.count ?? '0', 10);

    if (grantCount >= grantLimit) {
      return reply.status(402).send({
        message: `Plan limit reached: ${plan} plan allows ${grantLimit} active grant(s). Upgrade at /v1/billing/checkout`,
        code: 'PLAN_LIMIT_EXCEEDED',
        requestId: request.id,
      });
    }

    // Verify agent belongs to this developer
    const agentRows = await sql`
      SELECT id FROM agents WHERE id = ${agentId} AND developer_id = ${developerId} AND status = 'active'
    `;
    if (!agentRows[0]) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }

    // Evaluate policies via pluggable backend (builtin, OPA, or Cedar)
    const policyDecision = await getPolicyBackend().evaluate({
      agentId,
      principalId,
      scopes,
      developerId,
    });
    const policyEffect = policyDecision.effect;

    if (policyEffect === 'deny') {
      return reply.status(403).send({
        message: 'Authorization denied by policy',
        code: 'POLICY_DENIED',
        requestId: request.id,
      });
    }

    let expiresSeconds: number;
    try {
      expiresSeconds = parseExpiresIn(expiresIn);
    } catch {
      return reply.status(400).send({
        message: 'Invalid expiresIn format. Use e.g. "1h", "30m", "24h".',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);

    const id = newAuthRequestId();

    const isSandbox = request.developer.mode === 'sandbox';
    const isPolicyAllow = policyEffect === 'allow';
    const autoApprove = isSandbox || isPolicyAllow;
    const autoCode = autoApprove ? ulid() : null;

    await sql`
      INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, redirect_uri, state, expires_in, expires_at, audience, status, code, code_challenge, code_challenge_method)
      VALUES (
        ${id}, ${agentId}, ${principalId}, ${developerId}, ${scopes},
        ${redirectUri ?? null}, ${state ?? null}, ${expiresIn}, ${expiresAt},
        ${audience ?? null},
        ${autoApprove ? 'approved' : 'pending'},
        ${autoCode},
        ${codeChallenge ?? null},
        ${codeChallengeMethod ?? null}
      )
    `;

    const consentUrl = `${config.publicBaseUrl}/consent?req=${id}`;

    const responseBody: Record<string, unknown> = {
      authRequestId: id,
      consentUrl,
      expiresAt: expiresAt.toISOString(),
    };

    if (isSandbox) {
      responseBody['sandbox'] = true;
      responseBody['code'] = autoCode;
    } else if (isPolicyAllow) {
      responseBody['policyEnforced'] = true;
      responseBody['effect'] = 'allow';
      responseBody['code'] = autoCode;
    }

    authorizeTotal.inc({ status: 'success' });
    endTimer();

    // Usage metering (best-effort)
    incrementUsage(developerId, 'authorizations').catch(() => {});

    return reply.status(201).send(responseBody);
  });

  // POST /v1/authorize/:id/approve (internal/test endpoint)
  app.post<{ Params: { id: string } }>('/v1/authorize/:id/approve', async (request, reply) => {
    const sql = getSql();
    const code = ulid();

    const rows = await sql`
      UPDATE auth_requests
      SET status = 'approved', code = ${code}
      WHERE id = ${request.params.id}
        AND developer_id = ${request.developer.id}
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING id, status, code, expires_at
    `;

    const row = rows[0];
    if (!row) {
      return reply.status(404).send({ message: 'Auth request not found or already processed', code: 'NOT_FOUND', requestId: request.id });
    }

    return reply.send({ requestId: row['id'], status: row['status'], code: row['code'] });
  });

  // POST /v1/authorize/:id/deny
  app.post<{ Params: { id: string } }>('/v1/authorize/:id/deny', async (request, reply) => {
    const sql = getSql();

    const rows = await sql`
      UPDATE auth_requests
      SET status = 'denied'
      WHERE id = ${request.params.id}
        AND developer_id = ${request.developer.id}
        AND status = 'pending'
      RETURNING id, status
    `;

    const row = rows[0];
    if (!row) {
      return reply.status(404).send({ message: 'Auth request not found or already processed', code: 'NOT_FOUND', requestId: request.id });
    }

    return reply.send({ requestId: row['id'], status: row['status'] });
  });
}
