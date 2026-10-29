// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * OACP service-tenant enrolment, under /v1/commerce (migration 137).
 *
 *   POST /oacp/service-tenants                     enrol a tenant, merchant and catalogue source
 *   GET  /oacp/service-tenants/:tenantId           read one enrolment (platform admin)
 *   POST /oacp/service-tenants/:tenantId/revoke    revoke an enrolment (platform admin)
 *
 * Enrolment takes the AgenticOrg internal service token with the scope
 * `oacp.service_tenants.enrol`, or the platform admin. It is idempotent: the
 * merchant and source are added to the enrolment's lists, and the same call
 * again changes nothing. A revoked enrolment answers the service token
 * 403 `service_tenant_revoked`; only the platform admin can re-enrol it.
 * Every call is recorded in oacp_service_tenant_enrolment_events.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OACP_SERVICE_TENANTS_ENROL_SCOPE, type CommerceCaller } from '../lib/commerce/caller.js';
import {
  ServiceTenantEnrolmentError,
  appendServiceTenantEvent,
  enrolServiceTenant,
  getServiceTenantEnrolment,
  isTenantUuid,
  parseEnrolServiceTenantBody,
  parseRevocationReason,
  revokeServiceTenant,
  type OacpServiceTenantEnrolment,
} from '../lib/commerce/oacp-service-tenants.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { getSql, queries } from '../db/client.js';

function view(enrolment: OacpServiceTenantEnrolment): Record<string, unknown> {
  return {
    tenant_id: enrolment.tenant_id,
    status: enrolment.status,
    merchant_ids: enrolment.merchant_ids,
    source_systems: enrolment.source_systems,
    evidence_ref: enrolment.evidence_ref,
    enrolled_at: enrolment.enrolled_at,
    updated_at: enrolment.updated_at,
    revoked_at: enrolment.revoked_at,
    revoked_reason: enrolment.revoked_reason,
  };
}

function rethrow(err: unknown): never {
  if (err instanceof ServiceTenantEnrolmentError) {
    throw new CommerceHttpError(err.status, err.code, err.message, {
      retryable: false,
      ...(err.field ? { details: { fields: { [err.field]: err.message } } } : {}),
    });
  }
  throw err;
}

function adminActor(request: FastifyRequest): string {
  const caller = request.commerceCaller as CommerceCaller | undefined;
  if (caller?.kind !== 'operator' || !caller.isPlatformAdmin) {
    throw new CommerceHttpError(403, 'platform_admin_required',
      'Only the platform admin reads or revokes OACP service-tenant enrolments', { retryable: false });
  }
  return caller.developerId === '__admin__' ? 'platform_admin' : `platform_admin:${caller.developerId}`;
}

function tenantParam(value: string): string {
  if (!isTenantUuid(value)) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
      details: { fields: { tenant_id: 'must be a UUID' } },
      retryable: false,
    });
  }
  return value.toLowerCase();
}

export async function commerceOacpServiceTenantRoutes(app: FastifyInstance) {
  app.post('/oacp/service-tenants', async (request, reply) => {
    const caller = request.commerceCaller as CommerceCaller | undefined;
    let actor: { id: string; platformAdmin: boolean };
    if (caller?.kind === 'service' && caller.scopes.includes(OACP_SERVICE_TENANTS_ENROL_SCOPE)) {
      actor = { id: `service:${caller.serviceId}`, platformAdmin: false };
    } else if (caller?.kind === 'operator' && caller.isPlatformAdmin) {
      actor = { id: adminActor(request), platformAdmin: true };
    } else {
      throw new CommerceHttpError(403, 'forbidden',
        'The AgenticOrg internal service token or the platform admin is required', { retryable: false });
    }
    let outcome: Awaited<ReturnType<typeof enrolServiceTenant>>;
    try {
      const input = parseEnrolServiceTenantBody(request.body);
      outcome = await enrolServiceTenant(getSql(), input, { ...actor, requestId: request.id });
    } catch (err) {
      rethrow(err);
    }
    reply.header('cache-control', 'no-store');
    return reply.status(200).send({ ...view(outcome.enrolment), changed: outcome.changed, audit_event_id: outcome.audit_event_id });
  });

  app.get<{ Params: { tenantId: string } }>('/oacp/service-tenants/:tenantId', async (request, reply) => {
    const actor = adminActor(request);
    const tenantId = tenantParam(request.params.tenantId);
    const sql = getSql();
    const enrolment = await getServiceTenantEnrolment(sql, tenantId);
    if (!enrolment) {
      throw new CommerceHttpError(404, 'service_tenant_not_found', 'No OACP service enrolment for this tenant', { retryable: false });
    }
    const auditEventId = await appendServiceTenantEvent(queries(sql), {
      tenant_id: tenantId, event_type: 'oacp.service_tenant.read', actor, request_id: request.id,
      metadata: { status: enrolment.status },
    });
    reply.header('cache-control', 'no-store');
    return reply.status(200).send({ ...view(enrolment), audit_event_id: auditEventId });
  });

  app.post<{ Params: { tenantId: string }; Body: { reason_code?: unknown } | undefined }>(
    '/oacp/service-tenants/:tenantId/revoke',
    async (request, reply) => {
      const actor = adminActor(request);
      const tenantId = tenantParam(request.params.tenantId);
      const body = request.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: { body: 'must be a JSON object' } }, retryable: false,
        });
      }
      const unknown = Object.keys(body).find((key) => key !== 'reason_code');
      if (unknown !== undefined) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
          details: { fields: { [unknown]: 'unknown member' } }, retryable: false,
        });
      }
      let outcome: Awaited<ReturnType<typeof revokeServiceTenant>>;
      try {
        outcome = await revokeServiceTenant(getSql(), tenantId, parseRevocationReason(body.reason_code),
          { id: actor, requestId: request.id });
      } catch (err) {
        rethrow(err);
      }
      reply.header('cache-control', 'no-store');
      return reply.status(200).send({
        ...view(outcome.enrolment),
        already_revoked: outcome.already_revoked,
        audit_event_id: outcome.audit_event_id,
      });
    },
  );
}
