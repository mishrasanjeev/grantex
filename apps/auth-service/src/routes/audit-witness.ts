/**
 * Audit witness checkpoints (G16): `POST /v1/audit/witness-checkpoints`
 * stores and countersigns a chain head that AgenticOrg anchors, and
 * `GET /v1/audit/witness-checkpoints?source&tenant_ref` reads them back.
 *
 * Authentication is the AgenticOrg internal service token of the C6Z
 * authority route (`COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN` or its SHA-256);
 * developer API keys are refused. These routes skip the developer auth
 * plugin and check the token themselves.
 *
 * Tenant scope: a `tenant_ref` that is a tenant UUID (what AgenticOrg sends)
 * must be a tenant the service token may act for: on
 * COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS or with an active OACP service
 * enrolment (403 SERVICE_TENANT_NOT_ALLOWED / SERVICE_TENANT_REVOKED
 * otherwise). A `tenant_ref` that is not a UUID is an opaque reference with
 * no tenant behind it to check, and is accepted as before.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { matchesAgenticOrgServiceToken } from '../lib/commerce/caller.js';
import { decideServiceTenant, isTenantUuid, serviceTenantAccess } from '../lib/commerce/oacp-service-tenants.js';
import { WitnessError, listWitnessCheckpoints, witnessCheckpoint } from '../lib/audit-witness.js';

const SERVICE_ID = 'agenticorg_c6z_authority';

function bearer(request: FastifyRequest): string | null {
  const header = request.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 16 && token.length <= 4096 ? token : null;
}

/** Sends 401 and returns false unless the caller presents the AgenticOrg service token. */
async function requireServiceToken(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const token = bearer(request);
  if (token !== null && matchesAgenticOrgServiceToken(token)) return true;
  await reply.status(401).send({
    message: 'The AgenticOrg internal service token is required',
    code: 'UNAUTHORIZED',
    requestId: request.id,
  });
  return false;
}

/** Sends 403 and returns false when `tenantRef` is a tenant UUID the service token may not act for. */
async function requireTenantRef(request: FastifyRequest, reply: FastifyReply, tenantRef: unknown): Promise<boolean> {
  if (!isTenantUuid(tenantRef)) return true;
  const verdict = decideServiceTenant(await serviceTenantAccess(getSql(), tenantRef));
  if (verdict === 'allowed') return true;
  const revoked = verdict === 'tenant_revoked';
  await reply.status(403).send({
    message: revoked
      ? 'The OACP service enrolment of this tenant is revoked'
      : 'The AgenticOrg service token is not allowed for this tenant',
    code: revoked ? 'SERVICE_TENANT_REVOKED' : 'SERVICE_TENANT_NOT_ALLOWED',
    requestId: request.id,
  });
  return false;
}

async function sendWitnessError(reply: FastifyReply, request: FastifyRequest, err: unknown): Promise<FastifyReply> {
  if (!(err instanceof WitnessError)) throw err;
  return reply.status(err.status).send({ message: err.message, code: err.code, ...err.extra, requestId: request.id });
}

export async function auditWitnessRoutes(app: FastifyInstance): Promise<void> {
  const routeConfig = { config: { skipAuth: true, rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.post('/v1/audit/witness-checkpoints', routeConfig, async (request, reply) => {
    if (!(await requireServiceToken(request, reply))) return reply;
    const body = request.body;
    const tenantRef = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['tenant_ref'] : undefined;
    if (!(await requireTenantRef(request, reply, tenantRef))) return reply;
    try {
      const { created, checkpoint } = await witnessCheckpoint(getSql(), request.body, SERVICE_ID);
      return reply.status(created ? 201 : 200).send({
        witness_id: checkpoint.witness_id,
        countersignature: checkpoint.countersignature,
        witnessed_at: checkpoint.witnessed_at,
        created,
      });
    } catch (err) {
      return sendWitnessError(reply, request, err);
    }
  });

  app.get<{ Querystring: Record<string, string> }>('/v1/audit/witness-checkpoints', routeConfig, async (request, reply) => {
    if (!(await requireServiceToken(request, reply))) return reply;
    if (!(await requireTenantRef(request, reply, request.query['tenant_ref']))) return reply;
    try {
      return reply.send(await listWitnessCheckpoints(getSql(), {
        source: request.query['source'],
        tenant_ref: request.query['tenant_ref'],
        ...(request.query['limit'] !== undefined ? { limit: request.query['limit'] } : {}),
      }));
    } catch (err) {
      return sendWitnessError(reply, request, err);
    }
  });
}
