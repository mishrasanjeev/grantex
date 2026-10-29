// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * POST /v1/commerce/oacp/commitment-evidence/settlement-receipts (G59): bind
 * an x402 or MPP settlement receipt to a commitment as a signed OACP
 * `commitment_evidence` artifact (lib/commerce/settlement-evidence-store.ts).
 *
 * Authentication is the AgenticOrg internal service token with the scope
 * `commerce.oacp.commitment_evidence.write`, restricted to the tenant
 * allowlist of the C6Z authority route
 * (`COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS`) or an enrolled tenant naming one
 * of its enrolled merchants. Grantex executes no payment here: it records and
 * signs what the relying party saw.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getSql } from '../db/client.js';
import { OACP_COMMITMENT_EVIDENCE_SERVICE_SCOPE, type CommerceCaller } from '../lib/commerce/caller.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { requireCallerForTenant } from './commerce-oacp-runtime.js';
import { SettlementEvidenceError, issueSettlementCommitmentEvidence } from '../lib/commerce/settlement-evidence-store.js';

async function requireService(request: FastifyRequest): Promise<void> {
  const caller = request.commerceCaller as CommerceCaller | undefined;
  if (caller?.kind !== 'service' || !caller.scopes.includes(OACP_COMMITMENT_EVIDENCE_SERVICE_SCOPE)) {
    throw new CommerceHttpError(403, 'forbidden', 'The AgenticOrg internal service token is required', { retryable: false });
  }
  const body = request.body;
  const field = (name: string): string | null => {
    const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
    return typeof value === 'string' ? value : null;
  };
  // The env bootstrap list, or an enrolled tenant naming an enrolled merchant.
  await requireCallerForTenant(request, field('tenant_id'), OACP_COMMITMENT_EVIDENCE_SERVICE_SCOPE, field('merchant_id'), {
    code: 'service_tenant_not_allowed',
    message: 'AgenticOrg service token is not allowed for this tenant',
  });
}

export async function commerceOacpSettlementEvidenceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/oacp/commitment-evidence/settlement-receipts', async (request, reply) => {
    await requireService(request);
    try {
      const { artifact, created } = await issueSettlementCommitmentEvidence(getSql(), request.body);
      return reply.status(created ? 201 : 200).send({
        artifact_id: artifact.artifact_id,
        envelope: artifact.envelope,
        payload: artifact.payload,
        status: artifact.status,
        created,
      });
    } catch (error) {
      if (error instanceof SettlementEvidenceError) {
        throw new CommerceHttpError(error.status, error.code, error.message, { retryable: false });
      }
      throw error;
    }
  });
}
