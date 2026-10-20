// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * OACP mandates, under /v1/commerce (G41, G45, G46).
 *
 * Authentication: the commerce caller resolver. Each route accepts the
 * AgenticOrg service token with the one route scope it carries there (for a
 * tenant in COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS), an operator of the
 * tenant, or the platform admin.
 *
 *   POST /oacp/mandates/intent        IntentMandate from a checkout passport
 *   POST /oacp/mandates/cart          CartMandate under an IntentMandate
 *   POST /oacp/mandates/payment       PaymentMandate under a CartMandate
 *   POST /oacp/mandates/verify        verify any of the three
 *   POST /oacp/mandates/:jti/revoke   revoke a mandate and its descendants
 *   POST /oacp/mandates/:jti/suspend  suspend one mandate (status 2), reversible
 *   POST /oacp/mandates/:jti/reinstate
 *
 * Suspension and reinstatement take the service token with its own scope
 * (commerce.oacp.mandates.suspend) or the platform admin; tenant operators
 * cannot suspend.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  OACP_MANDATES_CART_ISSUE_SCOPE,
  OACP_MANDATES_INTENT_ISSUE_SCOPE,
  OACP_MANDATES_PAYMENT_ISSUE_SCOPE,
  OACP_MANDATES_REVOKE_SCOPE,
  OACP_MANDATES_SUSPEND_SCOPE,
  type CommerceCaller,
  OACP_MANDATES_VERIFY_SCOPE,
} from '../lib/commerce/caller.js';
import {
  OacpMandateRefusal,
  OacpMandateStoreError,
  OacpMandateUnavailableError,
  getOacpMandateRecord,
  issueCartMandate,
  issueIntentMandate,
  issuePaymentMandate,
  revokeOacpMandate,
  setOacpMandateSuspension,
  verifyStoredOacpMandate,
  type OacpMandateIssued,
} from '../lib/commerce/mandates.js';
import { OACP_MANDATE_TYPES, oacpMandateHash, type OacpMandateType } from '../lib/commerce/oacp-mandate-jwt.js';
import { OacpIssuerKeyUnavailableError } from '../lib/commerce/oacp-issuer-keys.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { callerMayActForTenant, requireKind } from './commerce-oacp-runtime.js';

const COMMON = ['tenant_id', 'passport_jwt', 'presence'];
const FIELDS: Record<OacpMandateType, Set<string>> = {
  intent: new Set([...COMMON, 'description', 'max_amount', 'merchants', 'expires_at']),
  cart: new Set([...COMMON, 'intent_mandate', 'checkout', 'webauthn_assertion']),
  payment: new Set([...COMMON, 'cart_mandate', 'rail', 'token_binding']),
};
const ISSUE_SCOPE: Record<OacpMandateType, string> = {
  intent: OACP_MANDATES_INTENT_ISSUE_SCOPE,
  cart: OACP_MANDATES_CART_ISSUE_SCOPE,
  payment: OACP_MANDATES_PAYMENT_ISSUE_SCOPE,
};

function invalid(field: string, message: string): CommerceHttpError {
  return new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
    details: { fields: { [field]: message } },
    retryable: false,
  });
}

function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('body', 'must be a JSON object');
  return value as Record<string, unknown>;
}

function redisOrNull(): import('ioredis').Redis | null {
  try { return getRedis(); } catch { return null; }
}

function rethrow(err: unknown): never {
  if (err instanceof OacpMandateRefusal) {
    throw new CommerceHttpError(err.status, err.code, err.message, {
      retryable: false,
      ...(err.refusalRecordId ? { details: { refusal_record_id: err.refusalRecordId } } : {}),
      ...(err.auditEventId ? { auditEventId: err.auditEventId } : {}),
    });
  }
  if (err instanceof OacpMandateUnavailableError) {
    throw new CommerceHttpError(503, 'revocation_unavailable', err.message, { retryable: true });
  }
  if (err instanceof OacpIssuerKeyUnavailableError) {
    throw new CommerceHttpError(503, 'oacp_issuer_key_unavailable', err.message, { retryable: false });
  }
  throw err;
}

function issuedView(issued: OacpMandateIssued): Record<string, unknown> {
  return {
    mandate: issued.mandate,
    jti: issued.jti,
    mandate_type: issued.mandate_type,
    exp: issued.exp,
    status: issued.status,
    mandate_hash: issued.mandate_hash,
    claims: issued.claims,
    audit_event_id: issued.audit_event_id,
  };
}

export async function commerceOacpMandateRoutes(app: FastifyInstance) {
  for (const type of OACP_MANDATE_TYPES) {
    app.post(`/oacp/mandates/${type}`, async (request, reply) => {
      requireKind(request);
      const b = body(request);
      const unknown = Object.keys(b).find((key) => !FIELDS[type].has(key));
      if (unknown !== undefined) throw invalid(unknown, 'unknown member');
      if (typeof b['tenant_id'] !== 'string' || b['tenant_id'].length === 0) throw invalid('tenant_id', 'required');
      if (!callerMayActForTenant(request, b['tenant_id'], ISSUE_SCOPE[type])) {
        throw new CommerceHttpError(403, 'tenant_not_allowed', 'Caller may not request mandates for this tenant', { retryable: false });
      }
      if (typeof b['passport_jwt'] !== 'string' || b['passport_jwt'].length === 0 || b['passport_jwt'].length > 8192) {
        throw invalid('passport_jwt', 'required compact JWT');
      }
      const input = { ...b, tenant_id: b['tenant_id'], passport_jwt: b['passport_jwt'], request_id: request.id };
      const sql = getSql();
      let issued: OacpMandateIssued;
      try {
        issued = type === 'intent'
          ? await issueIntentMandate(sql, redisOrNull(), input as Parameters<typeof issueIntentMandate>[2])
          : type === 'cart'
            ? await issueCartMandate(sql, redisOrNull(), input as Parameters<typeof issueCartMandate>[2])
            : await issuePaymentMandate(sql, redisOrNull(), input as Parameters<typeof issuePaymentMandate>[2]);
      } catch (err) {
        rethrow(err);
      }
      reply.header('cache-control', 'no-store');
      return reply.status(201).send(issuedView(issued));
    });
  }

  app.post('/oacp/mandates/verify', async (request, reply) => {
    requireKind(request);
    const b = body(request);
    const unknown = Object.keys(b).find((key) => !['tenant_id', 'mandate', 'expected_type', 'expected_merchant_id'].includes(key));
    if (unknown !== undefined) throw invalid(unknown, 'unknown member');
    if (typeof b['tenant_id'] !== 'string' || b['tenant_id'].length === 0) throw invalid('tenant_id', 'required');
    if (!callerMayActForTenant(request, b['tenant_id'], OACP_MANDATES_VERIFY_SCOPE)) {
      throw new CommerceHttpError(403, 'tenant_not_allowed', 'Caller may not verify mandates for this tenant', { retryable: false });
    }
    if (typeof b['mandate'] !== 'string' || b['mandate'].length === 0 || b['mandate'].length > 32768) {
      throw invalid('mandate', 'required compact JWT');
    }
    const expectedType = b['expected_type'];
    if (expectedType !== undefined && !(OACP_MANDATE_TYPES as readonly unknown[]).includes(expectedType)) {
      throw invalid('expected_type', `must be one of ${OACP_MANDATE_TYPES.join(', ')}`);
    }
    if (b['expected_merchant_id'] !== undefined && (typeof b['expected_merchant_id'] !== 'string' || b['expected_merchant_id'].length === 0)) {
      throw invalid('expected_merchant_id', 'must be a non-empty string');
    }
    const result = await verifyStoredOacpMandate(getSql(), b['mandate'], {
      expected_type: expectedType as OacpMandateType | undefined,
      expected_audience: b['expected_merchant_id'] as string | undefined,
    });
    reply.header('cache-control', 'no-store');
    // A mandate of another tenant is refused as out of scope, its claims withheld.
    if (result.claims && result.claims['tenant_id'] !== b['tenant_id']) {
      return reply.status(200).send({ valid: false, refusal_code: 'mandate_scope_mismatch', mandate_type: result.mandate_type, claims: null });
    }
    return reply.status(200).send({
      valid: result.valid,
      refusal_code: result.refusal_code,
      mandate_type: result.mandate_type,
      mandate_hash: oacpMandateHash(b['mandate']),
      claims: result.claims,
    });
  });

  app.post<{ Params: { jti: string } }>('/oacp/mandates/:jti/revoke', async (request, reply) => {
    requireKind(request);
    const b = body(request);
    const unknown = Object.keys(b).find((key) => key !== 'reason_code');
    if (unknown !== undefined) throw invalid(unknown, 'unknown member');
    if (b['reason_code'] !== undefined && (typeof b['reason_code'] !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(b['reason_code']))) {
      throw invalid('reason_code', 'must match ^[a-z][a-z0-9_]{0,63}$');
    }
    const sql = getSql();
    const record = await getOacpMandateRecord(sql, request.params.jti);
    // Another tenant's mandate answers exactly like a missing one.
    if (!record || !callerMayActForTenant(request, record.tenant_id, OACP_MANDATES_REVOKE_SCOPE)) {
      throw new CommerceHttpError(404, 'mandate_not_found', 'OACP mandate not found', { retryable: false });
    }
    try {
      const result = await revokeOacpMandate(sql, record.jti, { reason_code: b['reason_code'] as string | undefined, request_id: request.id });
      return reply.status(result.already_revoked ? 200 : 201).send(result);
    } catch (err) {
      if (err instanceof OacpMandateStoreError) {
        throw new CommerceHttpError(err.code === 'mandate_not_found' ? 404 : 409, err.code, err.message, { retryable: false });
      }
      throw err;
    }
  });

  for (const action of ['suspend', 'reinstate'] as const) {
    app.post<{ Params: { jti: string } }>(`/oacp/mandates/:jti/${action}`, async (request, reply) => {
      requireKind(request);
      const b = body(request);
      const unknown = Object.keys(b).find((key) => key !== 'reason_code');
      if (unknown !== undefined) throw invalid(unknown, 'unknown member');
      if (b['reason_code'] !== undefined && (typeof b['reason_code'] !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(b['reason_code']))) {
        throw invalid('reason_code', 'must match ^[a-z][a-z0-9_]{0,63}$');
      }
      const sql = getSql();
      const record = await getOacpMandateRecord(sql, request.params.jti);
      if (!record || !callerMaySuspend(request, record.tenant_id, OACP_MANDATES_SUSPEND_SCOPE)) {
        throw new CommerceHttpError(404, 'mandate_not_found', 'OACP mandate not found', { retryable: false });
      }
      try {
        const result = await setOacpMandateSuspension(sql, record.jti, action === 'suspend', {
          reason_code: b['reason_code'] as string | undefined, request_id: request.id,
        });
        return reply.status(result.changed ? 201 : 200).send(result);
      } catch (err) {
        if (err instanceof OacpMandateStoreError) {
          throw new CommerceHttpError(err.code === 'mandate_not_found' ? 404 : 409, err.code, err.message, { retryable: false });
        }
        throw err;
      }
    });
  }
}

/** Suspension is the platform admin's or the authority service's (own scope, allow-listed tenant), never a tenant operator's. */
export function callerMaySuspend(request: FastifyRequest, tenantId: string | null, scope: string): boolean {
  const caller = request.commerceCaller as CommerceCaller | undefined;
  if (caller?.kind === 'operator') return caller.isPlatformAdmin;
  return caller?.kind === 'service' && callerMayActForTenant(request, tenantId, scope);
}
