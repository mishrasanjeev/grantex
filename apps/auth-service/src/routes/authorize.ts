import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { newAuthRequestId } from '../lib/ids.js';
import { config } from '../config.js';
import { ulid } from 'ulid';
import { evaluatePolicies, type PolicyRow } from '../lib/policy.js';

interface AuthorizeBody {
  agentId: string;
  principalId: string;
  scopes: string[];
  redirectUri?: string;
  state?: string;
  expiresIn?: string;
  audience?: string;
}

export async function authorizeRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/authorize
  app.post<{ Body: AuthorizeBody }>('/v1/authorize', async (request, reply) => {
    const { agentId, principalId, scopes, redirectUri, state, expiresIn = '24h', audience } = request.body;

    if (!agentId || !principalId || !scopes?.length) {
      return reply.status(400).send({
        message: 'agentId, principalId, and scopes are required',
        code: 'BAD_REQUEST',
        requestId: request.id,
      });
    }

    const sql = getSql();
    const developerId = request.developer.id;

    // Verify agent belongs to this developer
    const agentRows = await sql`
      SELECT id FROM agents WHERE id = ${agentId} AND developer_id = ${developerId} AND status = 'active'
    `;
    if (!agentRows[0]) {
      return reply.status(404).send({ message: 'Agent not found', code: 'NOT_FOUND', requestId: request.id });
    }

    // Evaluate policies — query ordered by priority DESC, then created_at ASC
    const policyRows = await sql<PolicyRow[]>`
      SELECT id, effect, priority, agent_id, principal_id, scopes,
             time_of_day_start, time_of_day_end
      FROM policies
      WHERE developer_id = ${developerId}
      ORDER BY priority DESC, created_at ASC
    `;

    const policyEffect = evaluatePolicies(policyRows, { agentId, principalId, scopes });

    if (policyEffect === 'deny') {
      return reply.status(403).send({
        message: 'Authorization denied by policy',
        code: 'POLICY_DENIED',
        requestId: request.id,
      });
    }

    // Parse expiresIn to compute expires_at
    const expiresSeconds = parseExpiresIn(expiresIn);
    const expiresAt = new Date(Date.now() + expiresSeconds * 1000);

    const id = newAuthRequestId();

    const isSandbox = request.developer.mode === 'sandbox';
    const isPolicyAllow = policyEffect === 'allow';
    const autoApprove = isSandbox || isPolicyAllow;
    const autoCode = autoApprove ? ulid() : null;

    await sql`
      INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, redirect_uri, state, expires_in, expires_at, audience, status, code)
      VALUES (
        ${id}, ${agentId}, ${principalId}, ${developerId}, ${scopes},
        ${redirectUri ?? null}, ${state ?? null}, ${expiresIn}, ${expiresAt},
        ${audience ?? null},
        ${autoApprove ? 'approved' : 'pending'},
        ${autoCode}
      )
    `;

    const consentUrl = `${config.jwtIssuer}/consent?req=${id}`;

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

function parseExpiresIn(expiresIn: string): number {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  if (!match) return 86400; // default 24h
  const [, amount, unit] = match;
  const n = parseInt(amount!, 10);
  switch (unit) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return 86400;
  }
}
