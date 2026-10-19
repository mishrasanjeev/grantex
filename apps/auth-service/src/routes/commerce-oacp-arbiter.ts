/**
 * POST /v1/commerce/oacp/arbiter-decisions (G16). AgenticOrg's policy arbiter
 * records every decision it seals; an `allow` is answered with a
 * machine-profile decision grant (spec/decision-grant.md section 10), a
 * `refuse` is recorded and answered `{recorded: true}` with nothing minted.
 *
 * Authentication is the AgenticOrg internal service token of the C6Z
 * authority route (`COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN`), restricted to the
 * same tenant allowlist (`COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS`). Developer,
 * merchant and agent credentials are refused: only the arbiter decides.
 */
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { OACP_ARBITER_DECISIONS_SERVICE_SCOPE, type CommerceCaller } from '../lib/commerce/caller.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { recordArbiterDecision } from '../lib/commerce/oacp-arbiter-decisions.js';

function allowedServiceTenants(): Set<string> {
  return new Set(
    (process.env['COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function requireArbiterService(caller: CommerceCaller | undefined, body: unknown): string {
  if (caller?.kind !== 'service' || !caller.scopes.includes(OACP_ARBITER_DECISIONS_SERVICE_SCOPE)) {
    throw new CommerceHttpError(403, 'forbidden', 'The AgenticOrg internal service token is required', { retryable: false });
  }
  const tenantId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['tenant_id'] : undefined;
  if (typeof tenantId !== 'string' || !allowedServiceTenants().has(tenantId)) {
    throw new CommerceHttpError(403, 'service_tenant_not_allowed',
      'AgenticOrg service token is not allowed for this tenant', { retryable: false });
  }
  return caller.serviceId;
}

export async function commerceOacpArbiterRoutes(app: FastifyInstance): Promise<void> {
  app.post('/oacp/arbiter-decisions', async (request, reply) => {
    const serviceId = requireArbiterService(request.commerceCaller, request.body);
    const answer = await recordArbiterDecision(getSql(), request.body, serviceId);
    return reply.status(answer.status).send(answer.body);
  });
}
