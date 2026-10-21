// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * POST /v1/commerce/oacp/commitment-evidence/settlement-receipts (G59): bind
 * an x402 or MPP settlement receipt to a commitment as a signed OACP
 * `commitment_evidence` artifact (lib/commerce/settlement-evidence-store.ts).
 *
 * Authentication is the AgenticOrg internal service token with the scope
 * `commerce.oacp.commitment_evidence.write`, restricted to the tenant
 * allowlist of the C6Z authority route
 * (`COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS`). Grantex executes no payment
 * here: it records and signs what the relying party saw.
 */
import type { FastifyInstance } from 'fastify';
import { getSql } from '../db/client.js';
import { OACP_COMMITMENT_EVIDENCE_SERVICE_SCOPE, type CommerceCaller } from '../lib/commerce/caller.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { SettlementEvidenceError, issueSettlementCommitmentEvidence } from '../lib/commerce/settlement-evidence-store.js';

function allowedServiceTenants(): Set<string> {
  return new Set(
    (process.env['COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function requireService(caller: CommerceCaller | undefined, body: unknown): void {
  if (caller?.kind !== 'service' || !caller.scopes.includes(OACP_COMMITMENT_EVIDENCE_SERVICE_SCOPE)) {
    throw new CommerceHttpError(403, 'forbidden', 'The AgenticOrg internal service token is required', { retryable: false });
  }
  const tenantId = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['tenant_id'] : undefined;
  if (typeof tenantId !== 'string' || !allowedServiceTenants().has(tenantId)) {
    throw new CommerceHttpError(403, 'service_tenant_not_allowed',
      'AgenticOrg service token is not allowed for this tenant', { retryable: false });
  }
}

export async function commerceOacpSettlementEvidenceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/oacp/commitment-evidence/settlement-receipts', async (request, reply) => {
    requireService(request.commerceCaller, request.body);
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
