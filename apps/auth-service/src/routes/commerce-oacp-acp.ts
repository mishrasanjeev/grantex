// SPDX-License-Identifier: Apache-2.0
/**
 * ACP surfaces Grantex serves to the merchant runtime, under /v1/commerce.
 *
 * Authentication: the commerce caller resolver. Each route accepts the
 * AgenticOrg service token with the one route scope it carries there (for a
 * tenant in COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS), an operator of the
 * tenant, or the platform admin.
 *
 *   POST /oacp/acp/delegate-payment-allowance   ACP delegate-payment allowance and
 *                                               risk-signal envelope from a checkout
 *                                               Commerce Passport (G35)
 */
import type { FastifyInstance } from 'fastify';
import { ACP_DELEGATE_PAYMENT_ALLOWANCE_SCOPE } from '../lib/commerce/caller.js';
import {
  AcpAllowanceError,
  assertNoCardData,
  deriveAcpDelegatePaymentEnvelope,
} from '../lib/commerce/acp-delegate-payment.js';
import { verifyCommercePassport, type VerifyPassportError } from '../lib/commerce/passport.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { callerMayActForTenant, requireKind } from './commerce-oacp-runtime.js';

interface AllowanceBody {
  tenant_id?: unknown;
  passport_jwt?: unknown;
  checkout_session_id?: unknown;
  merchant_id?: unknown;
  amount?: unknown;
  currency?: unknown;
}

const ALLOWANCE_FIELDS = new Set(['tenant_id', 'passport_jwt', 'checkout_session_id', 'merchant_id', 'amount', 'currency']);

function invalid(field: string, message: string): CommerceHttpError {
  return new CommerceHttpError(422, 'validation_failed', 'Request validation failed', {
    details: { fields: { [field]: message } },
    retryable: false,
  });
}

function passportFailure(error: VerifyPassportError): CommerceHttpError {
  if (error.kind === 'revocation_unavailable') {
    return new CommerceHttpError(503, 'revocation_unavailable', 'Passport revocation state is unavailable; refusing', { retryable: true });
  }
  if (error.kind === 'tenant_mismatch' || error.kind === 'merchant_mismatch') {
    return new CommerceHttpError(403, `passport_${error.kind}`, 'The passport belongs to another tenant or merchant', { retryable: false });
  }
  if (error.kind === 'revoked') {
    return new CommerceHttpError(403, 'passport_revoked', 'The passport is revoked', { retryable: false });
  }
  return new CommerceHttpError(400, 'passport_invalid', `Passport verification failed (${error.kind})`, { retryable: false });
}

export async function commerceOacpAcpRoutes(app: FastifyInstance) {
  app.post<{ Body: AllowanceBody }>('/oacp/acp/delegate-payment-allowance', async (request, reply) => {
    requireKind(request);
    const body = (request.body ?? {}) as AllowanceBody;
    if (typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'must be a JSON object');
    try {
      assertNoCardData(body);
    } catch (err) {
      if (err instanceof AcpAllowanceError) throw new CommerceHttpError(err.status, err.code, err.message, { retryable: false });
      throw err;
    }
    const unknown = Object.keys(body).find((key) => !ALLOWANCE_FIELDS.has(key));
    if (unknown !== undefined) throw invalid(unknown, 'unknown member');
    if (typeof body.tenant_id !== 'string' || body.tenant_id.length === 0) throw invalid('tenant_id', 'required');
    if (!callerMayActForTenant(request, body.tenant_id, ACP_DELEGATE_PAYMENT_ALLOWANCE_SCOPE)) {
      throw new CommerceHttpError(403, 'tenant_not_allowed', 'Caller may not derive allowances for this tenant', { retryable: false });
    }
    if (typeof body.passport_jwt !== 'string' || body.passport_jwt.length === 0 || body.passport_jwt.length > 8192) {
      throw invalid('passport_jwt', 'required compact JWT');
    }
    if (typeof body.checkout_session_id !== 'string') throw invalid('checkout_session_id', 'required');
    if (body.merchant_id !== undefined && (typeof body.merchant_id !== 'string' || body.merchant_id.length === 0)) {
      throw invalid('merchant_id', 'must be a non-empty string');
    }
    if (body.amount !== undefined && typeof body.amount !== 'number') throw invalid('amount', 'must be an integer in minor units');
    if (body.currency !== undefined && typeof body.currency !== 'string') throw invalid('currency', 'must be an ISO 4217 code');

    const sql = getSql();
    let redis: import('ioredis').Redis | null = null;
    try { redis = getRedis(); } catch { redis = null; }
    // Payment-affecting: the online revocation check runs and fails closed.
    const verified = await verifyCommercePassport(sql, redis, body.passport_jwt, {
      mode: 'payment_affecting',
      expectedTenantId: body.tenant_id,
      ...(typeof body.merchant_id === 'string' ? { expectedMerchantId: body.merchant_id } : {}),
    });
    const audit = (eventType: 'acp.delegate_payment_allowance.issued' | 'acp.delegate_payment_allowance.refused',
      metadata: Record<string, unknown>, passport?: { jti: string; merchantId: string; agentId: string; subject: string; policyVersion: string | null }) =>
      appendCommerceAudit(sql, {
        tenantId: body.tenant_id as string,
        merchantId: passport?.merchantId ?? null,
        agentId: passport?.agentId ?? null,
        userPrincipalId: passport?.subject ?? null,
        eventType,
        resourceType: 'acp_checkout_session',
        resourceId: body.checkout_session_id as string,
        passportJti: passport?.jti ?? null,
        policyVersion: passport?.policyVersion ?? null,
        requestId: request.id,
        metadata,
      });
    if (!verified.ok) {
      await audit('acp.delegate_payment_allowance.refused', { refusal: `passport_${verified.error.kind}` }).catch(() => undefined);
      throw passportFailure(verified.error);
    }
    let envelope;
    try {
      envelope = deriveAcpDelegatePaymentEnvelope(verified.passport, {
        checkout_session_id: body.checkout_session_id,
        amount: body.amount as number | undefined,
        currency: body.currency as string | undefined,
      });
    } catch (err) {
      if (err instanceof AcpAllowanceError) {
        await audit('acp.delegate_payment_allowance.refused', { refusal: err.code }, verified.passport).catch(() => undefined);
        throw new CommerceHttpError(err.status, err.code, err.message, { retryable: false });
      }
      throw err;
    }
    // The allowance is recorded before it is returned: no record, no allowance.
    const recorded = await audit('acp.delegate_payment_allowance.issued', {
      allowance: envelope.allowance,
      risk_signal_count: envelope.risk_signals.length,
      checks: envelope.authority.checks,
    }, verified.passport);
    reply.header('cache-control', 'no-store');
    return reply.status(200).send({ ...envelope, audit_event_id: recorded.id });
  });
}
