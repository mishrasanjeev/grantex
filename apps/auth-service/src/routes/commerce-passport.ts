import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { config } from '../config.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import { newCommercePassportJti } from '../lib/commerce/ids.js';
import {
  signCommercePassport,
  verifyCommercePassport,
  type PassportType,
  type Environment,
} from '../lib/commerce/passport.js';
import {
  createConsentRequest,
  findConsentByRequestId,
  canonicalPresentedPayload,
  sha256hex,
  type CreateConsentInput,
} from '../lib/commerce/consent.js';
import { timingSafeEqual } from 'node:crypto';
import { revokeCommercePassport } from '../lib/commerce/revocation.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';

type Sql = ReturnType<typeof postgres>;

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);
}
function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && Math.trunc(v) === v) return v;
  return null;
}

const SCOPE_BUNDLE: Record<PassportType, string[]> = {
  browse: ['commerce:catalog.read', 'commerce:inventory.read'],
  checkout: [
    'commerce:catalog.read',
    'commerce:inventory.read',
    'commerce:checkout.create',
    'commerce:payment.initiate',
    'commerce:payment.status.read',
  ],
};

const DEFAULT_TTL: Record<PassportType, number> = {
  browse: 3600,        // 60 min — spec §6
  checkout: 600,       // 10 min — spec §6
};

function consentRequiresUserConfirmation(passportType: PassportType): boolean {
  return passportType === 'checkout';
}

function publicConsentBaseUrl(): string {
  return process.env['COMMERCE_CONSENT_HOST']
    ? `https://${process.env['COMMERCE_CONSENT_HOST']}`
    : 'https://consent.grantex.dev';
}

function agentCallerOrThrow(req: FastifyRequest): Extract<CommerceCaller, { kind: 'agent' }> {
  if (req.commerceCaller.kind !== 'agent') {
    throw new CommerceHttpError(403, 'agent_required',
      'This endpoint requires an agent caller (JWT assertion or agent API key)');
  }
  return req.commerceCaller;
}

export async function commercePassportRoutes(app: FastifyInstance): Promise<void> {
  // --------------------------------------------------------------------
  // POST /passports/consent-requests — agent only
  // --------------------------------------------------------------------
  app.post(
    '/passports/consent-requests',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const caller = agentCallerOrThrow(request);
    const body = (request.body ?? {}) as {
      merchant_id?: unknown;
      passport_type?: unknown;
      requested_scopes?: unknown;
      max_amount?: unknown;
      currency?: unknown;
      // Renamed from user_principal_id (Finding 1). The agent supplies a
      // HINT of the user it expects to authorize. The actual user
      // identity is set ONLY at approval from the verified principal
      // session, and approve rejects when hint != authenticated principal.
      user_principal_hint?: unknown;
      ttl_seconds?: unknown;
    };

    const fieldErrors: Record<string, string> = {};
    if (!isString(body.merchant_id)) fieldErrors['merchant_id'] = 'required string';
    if (body.passport_type !== 'browse' && body.passport_type !== 'checkout') {
      fieldErrors['passport_type'] = 'must be "browse" or "checkout"';
    }
    const passportType = (body.passport_type === 'checkout' ? 'checkout' : 'browse') as PassportType;
    const requestedScopes = isStringArray(body.requested_scopes)
      ? (body.requested_scopes as string[])
      : SCOPE_BUNDLE[passportType];
    // Subset enforcement: agent cannot request scopes outside the bundle for the type.
    const allowed = new Set(SCOPE_BUNDLE[passportType]);
    const overreach = requestedScopes.filter((s) => !allowed.has(s));
    if (overreach.length) {
      fieldErrors['requested_scopes'] = `scopes outside the ${passportType} bundle: ${overreach.join(', ')}`;
    }
    if (passportType === 'checkout') {
      if (asInt(body.max_amount) === null || (asInt(body.max_amount) as number) < 0) {
        fieldErrors['max_amount'] = 'required non-negative integer (minor units) for checkout passports';
      }
      if (!isString(body.currency)) {
        fieldErrors['currency'] = 'required string for checkout passports';
      }
    }
    if (Object.keys(fieldErrors).length) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    const sql = getSql();
    // Verify merchant exists in caller's tenant.
    const merchantRows = await sql<{ id: string; environment: string }[]>`
      SELECT id, environment FROM commerce_merchants
       WHERE id = ${body.merchant_id as string}
         AND tenant_id = ${caller.tenantId}
       LIMIT 1
    `;
    if (!merchantRows[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const ttlSeconds = asInt(body.ttl_seconds) ?? DEFAULT_TTL[passportType];
    const cappedTtl = Math.min(ttlSeconds, DEFAULT_TTL[passportType]);

    const userPrincipalHint = isString(body.user_principal_hint)
      ? (body.user_principal_hint as string)
      : null;

    const created = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      // createConsentRequest writes user_principal_hint (agent-supplied).
      // user_principal_id is set ONLY at approval from the verified
      // principal session — the agent never writes it.
      const c = await createConsentRequest(tx as unknown as Sql, {
        tenantId: caller.tenantId,
        merchantId: body.merchant_id as string,
        agentId: caller.agentId,
        passportType,
        requestedScopes,
        maxAmount: passportType === 'checkout' ? (asInt(body.max_amount) as number) : null,
        currency: passportType === 'checkout' ? (body.currency as string) : null,
        agentAuthMethod: caller.authMethod,
        ipHash: null,
        userAgentHash: null,
        ttlSeconds: cappedTtl,
        userPrincipalHint,
      } satisfies CreateConsentInput);
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId: caller.tenantId,
        merchantId: body.merchant_id as string,
        agentId: caller.agentId,
        // The hint is recorded in metadata for forensic clarity; it is
        // NOT a verified user_principal_id. (When set as
        // userPrincipalId on the audit row it would imply verification,
        // which it does not have at this stage.)
        eventType: 'consent.requested',
        resourceType: 'commerce_consent_record',
        resourceId: c.id,
        requestId: request.id,
        metadata: {
          passport_type: passportType,
          agent_auth_method: caller.authMethod,
          ttl_seconds: cappedTtl,
          requires_final_user_confirmation: consentRequiresUserConfirmation(passportType),
          user_principal_hint: userPrincipalHint,
        },
      });
      return { ...c, auditEventId: audit.id };
    });

    const consentUrl = `${publicConsentBaseUrl()}/v1/commerce/consent/page?req=${encodeURIComponent(created.consentRequestId)}`;
    return reply.status(201).send({
      data: {
        consent_request_id: created.consentRequestId,
        consent_record_id: created.id,
        consent_url: consentUrl,
        expires_at: created.expiresAt,
        passport_type: passportType,
      },
      audit_event_id: created.auditEventId,
    });
    },
  );

  // --------------------------------------------------------------------
  // POST /passports/exchange — agent only; mints the passport
  // --------------------------------------------------------------------
  app.post(
    '/passports/exchange',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const caller = agentCallerOrThrow(request);
    const body = (request.body ?? {}) as { consent_request_id?: unknown };
    if (!isString(body.consent_request_id)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { consent_request_id: 'required string' } }, retryable: false });
    }

    const sql = getSql();
    const consent = await findConsentByRequestId(sql, body.consent_request_id as string);
    if (!consent) {
      throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
    }
    if (consent.tenantId !== caller.tenantId || consent.agentId !== caller.agentId) {
      // Cross-agent or cross-tenant — same-shape 404 to avoid leaks.
      throw new CommerceHttpError(404, 'consent_not_found', 'Consent request not found');
    }
    if (consent.status === 'denied') {
      throw new CommerceHttpError(403, 'consent_denied', 'User denied this consent request');
    }
    if (consent.status === 'expired' || new Date(consent.expiresAt).getTime() < Date.now()) {
      throw new CommerceHttpError(410, 'consent_expired', 'Consent request has expired');
    }
    if (consent.status !== 'granted') {
      throw new CommerceHttpError(409, 'consent_not_granted',
        'Consent request has not been granted yet; redirect the user to the consent page');
    }
    if (!consent.presentedPayloadHash) {
      // Granted but never presented — defensive.
      throw new CommerceHttpError(409, 'consent_not_presented',
        'Consent record is missing presented_payload_hash; this should not happen for granted records');
    }
    if (!consent.userPrincipalId) {
      // user_principal_id is set at approval time from the authenticated
      // principal session (Finding 1 fix). If it's missing on a granted
      // consent, the approve path was bypassed — refuse to mint.
      throw new CommerceHttpError(409, 'consent_missing_subject',
        'Consent record has no authenticated user_principal_id; cannot mint passport');
    }
    // Defense in depth: if the agent supplied a hint, it must match the
    // authenticated principal recorded at approval. The approve lib
    // already enforces this, but checking here guards against a granted
    // record being mutated post-approval (which the schema prevents but
    // a future schema change could regress).
    if (consent.userPrincipalHint
      && consent.userPrincipalHint !== consent.userPrincipalId) {
      throw new CommerceHttpError(409, 'consent_principal_mismatch',
        'Authenticated principal does not match the user this consent was created for');
    }

    // Finding 4: recompute the canonical presented payload hash and
    // compare timing-safe to the value captured at first GET. A mismatch
    // means a row that's claimed to be presented now no longer matches
    // what the user actually saw — defense in depth against tampering.
    const recomputed = sha256hex(canonicalPresentedPayload(consent));
    const storedBuf = Buffer.from(consent.presentedPayloadHash, 'hex');
    const recomputedBuf = Buffer.from(recomputed, 'hex');
    if (storedBuf.length !== recomputedBuf.length || !timingSafeEqual(storedBuf, recomputedBuf)) {
      throw new CommerceHttpError(409, 'consent_payload_changed',
        'The consent payload differs from what the user approved. Re-request consent.',
        { retryable: false });
    }

    // Finding 3 (lib-side guard): refuse if a passport was already minted
    // for this consent record. The DB-level UNIQUE on
    // commerce_passports.consent_record_id provides the authoritative
    // single-use guarantee under concurrency; this pre-check returns the
    // friendlier 409 without depending on the FK violation message.
    const existingPassport = await sql<{ jti: string; expires_at: Date }[]>`
      SELECT jti, expires_at FROM commerce_passports
       WHERE consent_record_id = ${consent.id} LIMIT 1
    `;
    if (existingPassport[0]) {
      throw new CommerceHttpError(409, 'consent_already_exchanged',
        'A passport has already been issued for this consent. Each consent is single-use.',
        {
          retryable: false,
          details: {
            existing_jti: existingPassport[0].jti,
            existing_expires_at: existingPassport[0].expires_at instanceof Date
              ? existingPassport[0].expires_at.toISOString()
              : String(existingPassport[0].expires_at),
          },
        });
    }

    // Determine environment from merchant + check tenant is active
    // (Finding 3). Joined into one SELECT for efficiency.
    const merchant = await sql<{ environment: string; tenant_status: string }[]>`
      SELECT m.environment, t.status AS tenant_status
        FROM commerce_merchants m
        JOIN commerce_tenants t ON t.id = m.tenant_id
       WHERE m.id = ${consent.merchantId}
         AND m.tenant_id = ${consent.tenantId}
       LIMIT 1
    `;
    if (!merchant[0]) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    if (merchant[0].tenant_status === 'disabled') {
      throw new CommerceHttpError(403, 'tenant_disabled',
        'Commerce tenant is disabled; cannot mint new passports',
        { retryable: false });
    }
    const environment = (merchant[0].environment === 'live' ? 'live' : 'sandbox') as Environment;

    const now = Math.floor(Date.now() / 1000);
    const ttl = consent.passportType === 'checkout' ? DEFAULT_TTL.checkout : DEFAULT_TTL.browse;
    const expiresAt = now + ttl;
    const jti = newCommercePassportJti();

    const signed = await signCommercePassport(sql, {
      jti,
      passportType: consent.passportType,
      tenantId: consent.tenantId,
      merchantId: consent.merchantId,
      agentId: consent.agentId,
      consentRecordId: consent.id,
      subject: consent.userPrincipalId,
      scopes: consent.approvedScopes ?? consent.requestedScopes,
      maxAmount: consent.maxAmount,
      currency: consent.currency,
      environment,
      issuedAt: now,
      notBefore: now,
      expiresAt,
    });

    let result: { auditEventId: string; meterEventId: string };
    try {
      result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        await tx`
          INSERT INTO commerce_passports (
            jti, tenant_id, merchant_id, agent_id, consent_record_id,
            passport_type, kid, subject, scopes, max_amount, currency,
            environment, audience, issued_at, not_before, expires_at,
            agent_auth_method
          ) VALUES (
            ${signed.jti}, ${consent.tenantId}, ${consent.merchantId}, ${consent.agentId}, ${consent.id},
            ${consent.passportType}, ${signed.kid}, ${consent.userPrincipalId},
            ${consent.approvedScopes ?? consent.requestedScopes},
            ${consent.maxAmount}, ${consent.currency},
            ${environment}, ${'grantex-commerce'},
            to_timestamp(${now}), to_timestamp(${now}), to_timestamp(${expiresAt}),
            ${caller.authMethod}
          )
        `;
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId: consent.tenantId,
        merchantId: consent.merchantId,
        agentId: consent.agentId,
        userPrincipalId: consent.userPrincipalId,
        eventType: 'passport.issued',
        resourceType: 'commerce_passport',
        resourceId: signed.jti,
        passportJti: signed.jti,
        requestId: request.id,
        metadata: {
          passport_type: consent.passportType,
          kid: signed.kid,
          environment,
          agent_auth_method: caller.authMethod,
          ttl_seconds: ttl,
        },
      });
      const meter = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId: consent.tenantId,
        merchantId: consent.merchantId,
        agentId: consent.agentId,
        eventType: 'meter.passport_issued',
        resourceType: 'commerce_passport',
        resourceId: signed.jti,
        passportJti: signed.jti,
        requestId: request.id,
        metadata: { passport_type: consent.passportType },
      });
        return { auditEventId: audit.id, meterEventId: meter.id };
      });
    } catch (err) {
      // Concurrent exchange — the UNIQUE on consent_record_id fired.
      // Translate the postgres error to the friendly 409.
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw new CommerceHttpError(409, 'consent_already_exchanged',
          'A passport was already issued for this consent (concurrent exchange).',
          { retryable: false });
      }
      throw err;
    }

    return reply.status(201).send({
      data: {
        passport_jwt: signed.jwt,
        jti: signed.jti,
        kid: signed.kid,
        passport_type: consent.passportType,
        scopes: consent.approvedScopes ?? consent.requestedScopes,
        max_amount: consent.maxAmount,
        currency: consent.currency,
        expires_at: new Date(expiresAt * 1000).toISOString(),
      },
      audit_event_id: result.auditEventId,
    });
    },
  );

  // --------------------------------------------------------------------
  // GET /passports — list (operator + merchant + agent for own)
  // --------------------------------------------------------------------
  app.get(
    '/passports',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const sql = getSql();
    const caller = request.commerceCaller;
    let rows: Record<string, unknown>[];
    if (caller.kind === 'merchant') {
      rows = await sql<Record<string, unknown>[]>`
        SELECT p.jti, p.tenant_id, p.merchant_id, p.agent_id, p.passport_type,
               p.subject, p.scopes, p.max_amount, p.currency, p.environment,
               p.issued_at, p.expires_at,
               (rv.jti IS NOT NULL) AS revoked, rv.reason AS revocation_reason
          FROM commerce_passports p
          LEFT JOIN commerce_passport_revocations rv ON rv.jti = p.jti
         WHERE p.tenant_id = ${caller.tenantId}
           AND p.merchant_id = ${caller.merchantId}
         ORDER BY p.issued_at DESC
         LIMIT 100
      `;
    } else if (caller.kind === 'agent') {
      rows = await sql<Record<string, unknown>[]>`
        SELECT p.jti, p.tenant_id, p.merchant_id, p.agent_id, p.passport_type,
               p.subject, p.scopes, p.max_amount, p.currency, p.environment,
               p.issued_at, p.expires_at,
               (rv.jti IS NOT NULL) AS revoked, rv.reason AS revocation_reason
          FROM commerce_passports p
          LEFT JOIN commerce_passport_revocations rv ON rv.jti = p.jti
         WHERE p.tenant_id = ${caller.tenantId}
           AND p.agent_id = ${caller.agentId}
         ORDER BY p.issued_at DESC
         LIMIT 100
      `;
    } else {
      // operator
      rows = await sql<Record<string, unknown>[]>`
        SELECT p.jti, p.tenant_id, p.merchant_id, p.agent_id, p.passport_type,
               p.subject, p.scopes, p.max_amount, p.currency, p.environment,
               p.issued_at, p.expires_at,
               (rv.jti IS NOT NULL) AS revoked, rv.reason AS revocation_reason
          FROM commerce_passports p
          LEFT JOIN commerce_passport_revocations rv ON rv.jti = p.jti
         WHERE p.tenant_id = ${request.commerceTenantId}
         ORDER BY p.issued_at DESC
         LIMIT 100
      `;
    }
    return reply.status(200).send({ items: rows, next_cursor: null });
    },
  );

  // --------------------------------------------------------------------
  // POST /passports/verify — agent / merchant / operator
  // Body: { passport_jwt, mode? }
  // --------------------------------------------------------------------
  app.post(
    '/passports/verify',
    { config: { rateLimit: { max: 1000, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const body = (request.body ?? {}) as { passport_jwt?: unknown; mode?: unknown; expected_merchant_id?: unknown };
    if (!isString(body.passport_jwt)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { passport_jwt: 'required string' } }, retryable: false });
    }
    const mode = body.mode === 'payment_affecting' ? 'payment_affecting' : 'read_only';
    const sql = getSql();
    let redis: import('ioredis').Redis | null = null;
    try { redis = getRedis(); } catch { redis = null; }

    const expectedTenantId = request.commerceTenantId || undefined;
    const expectedMerchantId = isString(body.expected_merchant_id)
      ? (body.expected_merchant_id as string)
      : (request.commerceCaller.kind === 'merchant' ? request.commerceCaller.merchantId : undefined);

    const result = await verifyCommercePassport(sql, redis, body.passport_jwt as string, {
      mode,
      ...(expectedTenantId ? { expectedTenantId } : {}),
      ...(expectedMerchantId ? { expectedMerchantId } : {}),
    });

    if (!result.ok) {
      // Audit the failure for forensic visibility.
      await appendCommerceAudit(sql, {
        tenantId: request.commerceTenantId || 'unknown',
        eventType: 'passport.verification_failed',
        resourceType: 'commerce_passport',
        resourceId: '(verification rejected)',
        requestId: request.id,
        metadata: { error_kind: result.error.kind, mode },
      }).catch(() => undefined);
      // Map error kinds to HTTP statuses.
      const status =
        result.error.kind === 'revocation_unavailable' ? 503 :
        result.error.kind === 'tenant_mismatch' || result.error.kind === 'merchant_mismatch' ? 403 :
        400;
      const codeMap: Record<string, string> = {
        malformed: 'passport_malformed',
        kid_required: 'passport_kid_required',
        kid_unknown: 'passport_kid_unknown',
        kid_wrong_namespace: 'passport_kid_wrong_namespace',
        kid_retired_iat_after: 'passport_kid_retired_iat_after',
        kid_retired_window_exceeded: 'passport_kid_retired_window_exceeded',
        algorithm_rejected: 'passport_algorithm_rejected',
        signature_invalid: 'passport_signature_invalid',
        expired: 'passport_expired',
        not_yet_valid: 'passport_not_yet_valid',
        wrong_audience: 'passport_wrong_audience',
        wrong_issuer: 'passport_wrong_issuer',
        missing_claims: 'passport_missing_claims',
        temporal_claim_invalid: 'passport_temporal_claim_invalid',
        lifetime_exceeded: 'passport_lifetime_exceeded',
        invalid_passport_type: 'passport_invalid_type',
        revoked: 'passport_revoked',
        revocation_unavailable: 'revocation_unavailable',
        tenant_mismatch: 'passport_tenant_mismatch',
        merchant_mismatch: 'passport_merchant_mismatch',
      };
      const code = codeMap[result.error.kind] ?? 'passport_invalid';
      throw new CommerceHttpError(status, code,
        `Passport verification failed (${result.error.kind})`, {
          retryable: result.error.kind === 'revocation_unavailable',
          details: result.error as unknown as Record<string, unknown>,
        });
    }

    return reply.status(200).send({ data: { valid: true, passport: result.passport, mode } });
    },
  );

  // --------------------------------------------------------------------
  // POST /passports/revoke — operator + merchant (own) + agent (own)
  // Body: { jti, reason? }
  // --------------------------------------------------------------------
  app.post(
    '/passports/revoke',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const body = (request.body ?? {}) as { jti?: unknown; reason?: unknown };
    if (!isString(body.jti)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { jti: 'required string' } }, retryable: false });
    }
    const sql = getSql();
    const rows = await sql<{
      jti: string; tenant_id: string; merchant_id: string; agent_id: string;
    }[]>`
      SELECT jti, tenant_id, merchant_id, agent_id
        FROM commerce_passports WHERE jti = ${body.jti as string} LIMIT 1
    `;
    if (!rows[0]) {
      throw new CommerceHttpError(404, 'passport_not_found', 'Passport not found');
    }
    const passport = rows[0];
    if (passport.tenant_id !== request.commerceTenantId) {
      throw new CommerceHttpError(404, 'passport_not_found', 'Passport not found');
    }
    const caller = request.commerceCaller;
    if (caller.kind === 'merchant' && passport.merchant_id !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only revoke passports for their own merchant');
    }
    if (caller.kind === 'agent' && passport.agent_id !== caller.agentId) {
      throw new CommerceHttpError(403, 'agent_scope_violation',
        'Agent callers may only revoke their own passports');
    }

    let redis: import('ioredis').Redis | null = null;
    try { redis = getRedis(); } catch { redis = null; }
    const reason = isString(body.reason) ? (body.reason as string) : 'explicit';
    const revokedBy =
      caller.kind === 'operator' ? caller.developerId :
      caller.kind === 'merchant' ? `merchant_key:${caller.apiKeyId}` :
      caller.kind === 'agent' ? `agent:${caller.agentId}` :
      `service:${caller.kind === 'service' ? caller.serviceId : 'unknown'}`;

    await revokeCommercePassport(sql, redis, {
      jti: body.jti as string,
      tenantId: passport.tenant_id,
      reason,
      revokedBy,
    });

    const audit = await appendCommerceAudit(sql, {
      tenantId: passport.tenant_id,
      merchantId: passport.merchant_id,
      agentId: passport.agent_id,
      eventType: 'passport.revoked',
      resourceType: 'commerce_passport',
      resourceId: body.jti as string,
      passportJti: body.jti as string,
      requestId: request.id,
      metadata: { reason, revoked_by: revokedBy },
    });
    return reply.status(200).send({ data: { jti: body.jti, revoked: true, reason }, audit_event_id: audit.id });
    },
  );
}

// Side-effect-free re-export to keep the module surface lint-friendly.
export const _routesUseConfig = config;
