import type { FastifyInstance } from 'fastify';
import {
  C6Z_AUTHORITY_SERVICE_SCOPE,
  type CommerceCaller,
} from '../lib/commerce/caller.js';
import {
  issueC6ZInternalOacpArtifacts,
  validateC6ZSellerAuthorityRequest,
  type C6ZConnectorEvidence,
  type C6ZSellerAuthorityRequest,
} from '../lib/commerce/oacp-runtime-vertical.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';

interface C6ZAuthorityBody {
  request?: C6ZSellerAuthorityRequest;
  connector_evidence?: C6ZConnectorEvidence;
  now_iso?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireOperator(request: { commerceCaller?: { kind?: string } }): void {
  if (request.commerceCaller?.kind !== 'operator') {
    throw new CommerceHttpError(403, 'forbidden', 'Operator commerce caller required');
  }
}

function allowedServiceTenants(): Set<string> {
  return new Set(
    (process.env['COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS'] ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function requireAuthorityCaller(
  request: { commerceCaller?: CommerceCaller },
  body: C6ZAuthorityBody,
): void {
  const caller = request.commerceCaller;
  if (caller?.kind === 'operator') return;
  if (caller?.kind === 'service' && caller.scopes.includes(C6Z_AUTHORITY_SERVICE_SCOPE)) {
    const tenantId = body.request?.tenant_id;
    const allowed = allowedServiceTenants();
    if (typeof tenantId === 'string' && tenantId && allowed.has(tenantId)) return;
    throw new CommerceHttpError(
      403,
      'service_tenant_not_allowed',
      'AgenticOrg C6Z authority service token is not allowed for this tenant',
      { retryable: false },
    );
  }
  requireOperator(request);
}

export async function commerceOacpRuntimeRoutes(app: FastifyInstance) {
  app.post<{ Body: C6ZAuthorityBody }>('/oacp/c6z/authority-requests', async (request, reply) => {
    const body = request.body ?? {};
    requireAuthorityCaller(request, body);
    const now = typeof body.now_iso === 'string' && body.now_iso ? body.now_iso : nowIso();
    const authorityRequest = body.request;
    const requestStatus = validateC6ZSellerAuthorityRequest(authorityRequest, now);
    if (!body.connector_evidence || requestStatus.status !== 'artifact_issuance_ready') {
      const intakeOnly = !body.connector_evidence && requestStatus.status === 'artifact_issuance_ready';
      return reply.status(requestStatus.status === 'rejected' ? 422 : 202).send({
        ...requestStatus,
        status: intakeOnly ? 'received' : requestStatus.status,
        message: intakeOnly
          ? 'Authority request received. Connector evidence is required before internal C6Z artifact issuance.'
          : requestStatus.message,
        route_kind: 'grantex_internal_c6z_authority_request',
        artifact_issuance_attempted: false,
      });
    }
    const issuance = issueC6ZInternalOacpArtifacts({
      request: authorityRequest as C6ZSellerAuthorityRequest,
      evidence: body.connector_evidence,
      now_iso: now,
    });
    return reply.status(issuance.status === 'artifact_issuance_ready' ? 201 : 422).send({
      ...issuance,
      route_kind: 'grantex_internal_c6z_authority_request',
      artifact_issuance_attempted: true,
      artifact_count: issuance.artifacts.length,
    });
  });
}
