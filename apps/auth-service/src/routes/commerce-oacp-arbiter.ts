/**
 * POST /v1/commerce/oacp/arbiter-decisions (G16). AgenticOrg's policy arbiter
 * records every decision it seals; an `allow` is answered with a
 * machine-profile decision grant (spec/decision-grant.md section 10), a
 * `refuse` is recorded and answered `{recorded: true}` with nothing minted.
 *
 * Authentication is the AgenticOrg internal service token of the C6Z
 * authority route (`COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN`), restricted to the
 * same tenants (`COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS`, or an enrolled
 * tenant naming one of its enrolled merchants). Developer, merchant and agent
 * credentials are refused: only the arbiter decides.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { OACP_ARBITER_DECISIONS_SERVICE_SCOPE, type CommerceCaller } from '../lib/commerce/caller.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { requireCallerForTenant } from './commerce-oacp-runtime.js';
import { recordArbiterDecision } from '../lib/commerce/oacp-arbiter-decisions.js';

async function requireArbiterService(request: FastifyRequest): Promise<string> {
  const caller = request.commerceCaller as CommerceCaller | undefined;
  if (caller?.kind !== 'service' || !caller.scopes.includes(OACP_ARBITER_DECISIONS_SERVICE_SCOPE)) {
    throw new CommerceHttpError(403, 'forbidden', 'The AgenticOrg internal service token is required', { retryable: false });
  }
  const body = request.body;
  const field = (name: string): string | null => {
    const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
    return typeof value === 'string' ? value : null;
  };
  // The env bootstrap list, or an enrolled tenant naming an enrolled merchant.
  await requireCallerForTenant(request, field('tenant_id'), OACP_ARBITER_DECISIONS_SERVICE_SCOPE, field('merchant_id'), {
    code: 'service_tenant_not_allowed',
    message: 'AgenticOrg service token is not allowed for this tenant',
  });
  return caller.serviceId;
}

export async function commerceOacpArbiterRoutes(app: FastifyInstance): Promise<void> {
  app.post('/oacp/arbiter-decisions', async (request, reply) => {
    const serviceId = await requireArbiterService(request);
    const answer = await recordArbiterDecision(getSql(), request.body, serviceId);
    return reply.status(answer.status).send(answer.body);
  });
}
