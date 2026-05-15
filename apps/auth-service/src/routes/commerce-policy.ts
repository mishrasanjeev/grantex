import type { FastifyInstance, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { getSql, type TxSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import { CommerceHttpError } from '../lib/commerce/errors.js';
import { appendCommerceAudit } from '../lib/commerce/audit.js';
import {
  newCommercePolicyDecisionId,
  newCommercePolicyId,
} from '../lib/commerce/ids.js';
import type { CommerceCaller } from '../lib/commerce/caller.js';
import {
  assertPolicyCurrencyConsistency,
  evaluateCommercePolicyRules,
  isCommercePolicyScope,
  validateCommercePolicyRules,
  type CommercePolicyDecision,
  type CommercePolicyRules,
  type CommercePolicyScope,
} from '../lib/commerce/policy.js';
import {
  verifyCommercePassport,
  type VerifyPassportError,
  type VerifiedPassport,
} from '../lib/commerce/passport.js';

type Sql = ReturnType<typeof postgres>;

interface PolicyCreateBody {
  merchant_id?: unknown;
  rules?: unknown;
}

interface PolicyEvaluateBody {
  merchant_id?: unknown;
  agent_id?: unknown;
  passport_jwt?: unknown;
  action_scope?: unknown;
  scope?: unknown;
  amount_minor_units?: unknown;
  currency?: unknown;
  environment?: unknown;
  resource_type?: unknown;
  resource_id?: unknown;
}

interface MerchantReenableBody {
  reason?: unknown;
  reviewed_policy_id?: unknown;
  incident_reference?: unknown;
  confirm_reenable?: unknown;
}

interface MerchantPolicyContext {
  id: string;
  tenant_id: string;
  environment: 'sandbox' | 'live';
  default_currency: string;
  agentic_commerce_enabled: boolean;
  disabled_at: Date | string | null;
  tenant_status: 'active' | 'disabled';
}

interface AgentPolicyContext {
  id: string;
  tenant_id: string;
  trust_status: string;
  disabled_at: Date | string | null;
}

interface PolicyRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  version: string;
  rules: unknown;
  status: 'draft' | 'active' | 'archived';
  created_by: string;
  activated_by: string | null;
  activated_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number.parseInt(v, 10);
  return null;
}

function tenantIdOrThrow(request: FastifyRequest): string {
  if (!request.commerceTenantId) {
    throw new CommerceHttpError(
      422,
      'tenant_context_required',
      'This commerce endpoint requires a tenant-bound operator, merchant, or agent caller',
      { retryable: false },
    );
  }
  return request.commerceTenantId;
}

function actorId(caller: CommerceCaller): string {
  if (caller.kind === 'operator') return caller.developerId;
  if (caller.kind === 'merchant') return `merchant_key:${caller.apiKeyId}`;
  if (caller.kind === 'agent') return `agent:${caller.agentId}`;
  return `service:${caller.serviceId}`;
}

function merchantIdForManagement(request: FastifyRequest, bodyMerchantId: unknown): string {
  const caller = request.commerceCaller;
  if (caller.kind === 'merchant') {
    if (bodyMerchantId !== undefined && bodyMerchantId !== caller.merchantId) {
      throw new CommerceHttpError(403, 'merchant_scope_violation',
        'Merchant callers may only manage policies for their own merchant');
    }
    return caller.merchantId;
  }
  if (caller.kind === 'operator') {
    if (!isString(bodyMerchantId)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { merchant_id: 'required string' } }, retryable: false });
    }
    return bodyMerchantId;
  }
  throw new CommerceHttpError(403, 'policy_manager_required',
    'This endpoint requires an operator or merchant caller');
}

function requirePolicyManagerForMerchant(request: FastifyRequest, merchantId: string): void {
  const caller = request.commerceCaller;
  if (caller.kind === 'operator') return;
  if (caller.kind === 'merchant' && caller.merchantId === merchantId) return;
  throw new CommerceHttpError(403, 'policy_manager_required',
    'This endpoint requires an operator or the merchant whose policy is being managed');
}

function requireOperator(request: FastifyRequest): void {
  if (request.commerceCaller.kind !== 'operator') {
    throw new CommerceHttpError(403, 'operator_required',
      'This endpoint requires an operator caller');
  }
}

function requireEvaluatorScope(request: FastifyRequest, merchantId: string, agentId: string): void {
  const caller = request.commerceCaller;
  if (caller.kind === 'operator') return;
  if (caller.kind === 'merchant' && caller.merchantId === merchantId) return;
  if (caller.kind === 'agent' && caller.agentId === agentId) return;
  throw new CommerceHttpError(403, 'caller_not_authorized',
    'This endpoint requires operator, the merchant, or the agent being evaluated');
}

function parsePolicyVersion(version: string): number {
  const m = /^v([0-9]+)$/.exec(version);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

async function nextPolicyVersion(sql: Sql, tenantId: string, merchantId: string): Promise<string> {
  const rows = await sql<{ version: string }[]>`
    SELECT version
      FROM commerce_policies
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
     ORDER BY created_at DESC
     LIMIT 50
  `;
  const max = rows.reduce((acc, row) => Math.max(acc, parsePolicyVersion(row.version)), 0);
  return `v${max + 1}`;
}

async function loadMerchantContext(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<MerchantPolicyContext | null> {
  const rows = await sql<MerchantPolicyContext[]>`
    SELECT m.id, m.tenant_id,
           CASE WHEN m.environment = 'live' THEN 'live' ELSE 'sandbox' END AS environment,
           m.default_currency,
           m.agentic_commerce_enabled,
           m.disabled_at,
           CASE WHEN t.status = 'disabled' THEN 'disabled' ELSE 'active' END AS tenant_status
      FROM commerce_merchants m
      JOIN commerce_tenants t ON t.id = m.tenant_id
     WHERE m.id = ${merchantId}
       AND m.tenant_id = ${tenantId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadAgentContext(
  sql: Sql,
  tenantId: string,
  agentId: string,
): Promise<AgentPolicyContext | null> {
  const rows = await sql<AgentPolicyContext[]>`
    SELECT id, tenant_id, trust_status, disabled_at
      FROM commerce_agents
     WHERE id = ${agentId}
       AND tenant_id = ${tenantId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function loadActivePolicy(
  sql: Sql,
  tenantId: string,
  merchantId: string,
): Promise<PolicyRow | null> {
  const rows = await sql<PolicyRow[]>`
    SELECT id, tenant_id, merchant_id, version, rules, status,
           created_by, activated_by, activated_at, created_at, updated_at
      FROM commerce_policies
     WHERE tenant_id = ${tenantId}
       AND merchant_id = ${merchantId}
       AND status = 'active'
     LIMIT 1
  `;
  return rows[0] ?? null;
}

function validateRulesOrThrow(rulesInput: unknown): CommercePolicyRules {
  const validation = validateCommercePolicyRules(rulesInput);
  if (!validation.ok) {
    throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
      { details: { fields: validation.fieldErrors }, retryable: false });
  }
  return validation.rules;
}

async function sendPolicyDecision(
  sql: Sql,
  request: FastifyRequest,
  input: {
    decision: CommercePolicyDecision;
    reason: string;
    tenantId: string;
    merchantId: string;
    agentId: string;
    passportJti?: string | null;
    policy: PolicyRow;
    decisionId: string;
    resourceType?: string | null;
    resourceId?: string | null;
  },
): Promise<{ body: Record<string, unknown>; auditEventId: string | null }> {
  let auditEventId: string | null = null;
  if (input.decision !== 'allow') {
    const audit = await appendCommerceAudit(sql, {
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      agentId: input.agentId,
      eventType: 'policy.evaluated',
      resourceType: input.resourceType ?? 'commerce_policy',
      resourceId: input.resourceId ?? input.policy.id,
      passportJti: input.passportJti ?? null,
      policyVersion: input.policy.version,
      decisionId: input.decisionId,
      requestId: request.id,
      metadata: {
        decision: input.decision,
        reason: input.reason,
        policy_id: input.policy.id,
      },
    });
    auditEventId = audit.id;
  }

  return {
    auditEventId,
    body: {
      data: {
        decision: input.decision,
        reason: input.reason,
        policy_id: input.policy.id,
        policy_version: input.policy.version,
        decision_id: input.decisionId,
        ...(input.passportJti ? { passport_jti: input.passportJti } : {}),
      },
      ...(auditEventId ? { audit_event_id: auditEventId } : {}),
    },
  };
}

function passportFailureReason(error: VerifyPassportError): string {
  const map: Record<VerifyPassportError['kind'], string> = {
    malformed: 'passport_malformed',
    kid_required: 'passport_kid_required',
    kid_unknown: 'passport_kid_unknown',
    kid_wrong_namespace: 'passport_kid_wrong_namespace',
    kid_retired_iat_after: 'passport_kid_retired',
    kid_retired_window_exceeded: 'passport_kid_retired',
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
    tenant_mismatch: 'tenant_mismatch',
    merchant_mismatch: 'merchant_mismatch',
  };
  return map[error.kind] ?? 'passport_invalid';
}

function requiredAmountScope(scope: CommercePolicyScope): boolean {
  return scope === 'commerce:checkout.create' || scope === 'commerce:payment.initiate';
}

function passportTtlExceeded(passport: VerifiedPassport, rules: CommercePolicyRules): boolean {
  const ttlSeconds = passport.expiresAt - passport.issuedAt;
  const maxTtl = passport.passportType === 'checkout'
    ? rules.checkout_passport_max_ttl_seconds
    : rules.browse_passport_max_ttl_seconds;
  return ttlSeconds > maxTtl;
}

function normalizePolicyRow(row: PolicyRow): Record<string, unknown> {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    merchant_id: row.merchant_id,
    version: row.version,
    rules: row.rules,
    status: row.status,
    created_by: row.created_by,
    activated_by: row.activated_by,
    activated_at: row.activated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function commercePolicyRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PolicyCreateBody }>(
    '/policies',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const merchantId = merchantIdForManagement(request, request.body?.merchant_id);
    const rules = validateRulesOrThrow(request.body?.rules);
    const sql = getSql();

    const merchant = await loadMerchantContext(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }

    const version = await nextPolicyVersion(sql, tenantId, merchantId);
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      const policyRows = await tx<PolicyRow[]>`
        INSERT INTO commerce_policies (
          id, tenant_id, merchant_id, version, rules, status, created_by
        ) VALUES (
          ${newCommercePolicyId()},
          ${tenantId},
          ${merchantId},
          ${version},
          ${JSON.stringify(rules)}::jsonb,
          ${'draft'},
          ${actorId(request.commerceCaller)}
        )
        RETURNING id, tenant_id, merchant_id, version, rules, status,
                  created_by, activated_by, activated_at, created_at, updated_at
      `;
      const policy = policyRows[0];
      if (!policy) throw new Error('commerce policy insert returned no row');
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId,
        eventType: 'policy.created',
        resourceType: 'commerce_policy',
        resourceId: policy.id,
        policyVersion: policy.version,
        requestId: request.id,
        metadata: { status: 'draft' },
      });
      return { policy, auditEventId: audit.id };
    });

    return reply.status(201).send({
      data: normalizePolicyRow(result.policy),
      audit_event_id: result.auditEventId,
    });
    },
  );

  app.get<{
    Querystring: { merchant_id?: string; status?: string; limit?: string };
  }>('/policies', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const caller = request.commerceCaller;
    const merchantFilter = caller.kind === 'merchant'
      ? caller.merchantId
      : (isString(request.query.merchant_id) ? request.query.merchant_id : null);
    if (caller.kind !== 'operator' && caller.kind !== 'merchant') {
      throw new CommerceHttpError(403, 'policy_manager_required',
        'This endpoint requires an operator or merchant caller');
    }
    const status = isString(request.query.status) ? request.query.status : null;
    if (status && !['draft', 'active', 'archived'].includes(status)) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: { status: 'must be draft, active, or archived' } }, retryable: false });
    }
    const limit = Math.min(Math.max(asInt(request.query.limit) ?? 50, 1), 100);
    const sql = getSql();
    const rows = await sql<PolicyRow[]>`
      SELECT id, tenant_id, merchant_id, version, rules, status,
             created_by, activated_by, activated_at, created_at, updated_at
        FROM commerce_policies
       WHERE tenant_id = ${tenantId}
         AND (${merchantFilter}::text IS NULL OR merchant_id = ${merchantFilter})
         AND (${status}::text IS NULL OR status = ${status})
       ORDER BY created_at DESC
       LIMIT ${limit}
    `;
    return reply.status(200).send({ items: rows.map(normalizePolicyRow), next_cursor: null });
  });

  app.get<{ Params: { policyId: string } }>('/policies/:policyId', async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const sql = getSql();
    const rows = await sql<PolicyRow[]>`
      SELECT id, tenant_id, merchant_id, version, rules, status,
             created_by, activated_by, activated_at, created_at, updated_at
        FROM commerce_policies
       WHERE tenant_id = ${tenantId}
         AND id = ${request.params.policyId}
       LIMIT 1
    `;
    const policy = rows[0];
    if (!policy) {
      throw new CommerceHttpError(404, 'policy_not_found', 'Policy not found in this tenant');
    }
    requirePolicyManagerForMerchant(request, policy.merchant_id);
    return reply.status(200).send({ data: normalizePolicyRow(policy) });
  });

  app.post<{ Params: { policyId: string } }>(
    '/policies/:policyId/activate',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const sql = getSql();
    const rows = await sql<Array<PolicyRow & { default_currency: string }>>`
      SELECT p.id, p.tenant_id, p.merchant_id, p.version, p.rules, p.status,
             p.created_by, p.activated_by, p.activated_at, p.created_at, p.updated_at,
             m.default_currency
        FROM commerce_policies p
        JOIN commerce_merchants m
          ON m.tenant_id = p.tenant_id AND m.id = p.merchant_id
       WHERE p.tenant_id = ${tenantId}
         AND p.id = ${request.params.policyId}
       LIMIT 1
    `;
    const policy = rows[0];
    if (!policy) {
      throw new CommerceHttpError(404, 'policy_not_found', 'Policy not found in this tenant');
    }
    requirePolicyManagerForMerchant(request, policy.merchant_id);
    if (policy.status === 'active') {
      throw new CommerceHttpError(409, 'active_policy_immutable',
        'Active policies are immutable; create and activate a new policy version');
    }
    if (policy.status === 'archived') {
      throw new CommerceHttpError(409, 'policy_archived',
        'Archived policies cannot be activated; create a new policy version');
    }
    const rules = validateRulesOrThrow(policy.rules);
    const currencyErrors = assertPolicyCurrencyConsistency(rules, policy.default_currency);
    if (currencyErrors) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: currencyErrors }, retryable: false });
    }

    const actor = actorId(request.commerceCaller);
    const result = await sql.begin(async (_tx) => {
      const tx = _tx as unknown as TxSql;
      await tx`
        UPDATE commerce_policies
           SET status = 'archived', updated_at = NOW()
         WHERE tenant_id = ${tenantId}
           AND merchant_id = ${policy.merchant_id}
           AND status = 'active'
           AND id <> ${policy.id}
      `;
      const activatedRows = await tx<PolicyRow[]>`
        UPDATE commerce_policies
           SET status = 'active',
               activated_by = ${actor},
               activated_at = NOW(),
               updated_at = NOW()
         WHERE id = ${policy.id}
           AND tenant_id = ${tenantId}
           AND status = 'draft'
        RETURNING id, tenant_id, merchant_id, version, rules, status,
                  created_by, activated_by, activated_at, created_at, updated_at
      `;
      const activated = activatedRows[0];
      if (!activated) {
        throw new CommerceHttpError(409, 'policy_activation_conflict',
          'Policy could not be activated from draft state');
      }
      const audit = await appendCommerceAudit(tx as unknown as Sql, {
        tenantId,
        merchantId: activated.merchant_id,
        eventType: 'policy.activated',
        resourceType: 'commerce_policy',
        resourceId: activated.id,
        policyVersion: activated.version,
        requestId: request.id,
        metadata: { activated_by: actor },
      });
      return { policy: activated, auditEventId: audit.id };
    });

    return reply.status(200).send({
      data: normalizePolicyRow(result.policy),
      audit_event_id: result.auditEventId,
    });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: { reason?: unknown } }>(
    '/merchants/:merchantId/disable-agentic-commerce',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const tenantId = tenantIdOrThrow(request);
      requirePolicyManagerForMerchant(request, request.params.merchantId);
      const reason = isString(request.body?.reason) ? request.body.reason : 'emergency_disable';
      const sql = getSql();
      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx<Array<{
          id: string;
          tenant_id: string;
          agentic_commerce_enabled: boolean;
          updated_at: Date | string;
        }>>`
          UPDATE commerce_merchants
             SET agentic_commerce_enabled = FALSE,
                 updated_at = NOW()
           WHERE id = ${request.params.merchantId}
             AND tenant_id = ${tenantId}
             AND disabled_at IS NULL
          RETURNING id, tenant_id, agentic_commerce_enabled, updated_at
        `;
        const merchant = rows[0];
        if (!merchant) return null;
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId: merchant.id,
          eventType: 'merchant.feature_flag.updated',
          resourceType: 'merchant',
          resourceId: merchant.id,
          requestId: request.id,
          metadata: {
            flag: 'agentic_commerce_enabled',
            value: false,
            reason,
            emergency_disable: true,
          },
        });
        return { merchant, auditEventId: audit.id };
      });
      if (!result) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      return reply.status(200).send({
        data: {
          merchant_id: result.merchant.id,
          agentic_commerce_enabled: result.merchant.agentic_commerce_enabled,
          disabled: true,
        },
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Params: { merchantId: string }; Body: MerchantReenableBody }>(
    '/merchants/:merchantId/enable-agentic-commerce',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const tenantId = tenantIdOrThrow(request);
      requireOperator(request);
      const body = (request.body ?? {}) as Record<string, unknown>;
      const fieldErrors: Record<string, string> = {};
      const supportedFields = new Set(['reason', 'reviewed_policy_id', 'incident_reference', 'confirm_reenable']);
      const unsupportedFields = Object.keys(body).filter((key) => !supportedFields.has(key));
      if (unsupportedFields.length > 0) {
        fieldErrors['unsupported_fields'] =
          `unsupported fields: ${unsupportedFields.map((key) => key.replace(/[\r\n\t]/g, '_')).join(', ')}`;
      }
      if (!isString(body['reason'])) fieldErrors['reason'] = 'required non-empty string';
      if (!isString(body['reviewed_policy_id'])) {
        fieldErrors['reviewed_policy_id'] = 'required string';
      }
      if (body['incident_reference'] !== undefined && typeof body['incident_reference'] !== 'string') {
        fieldErrors['incident_reference'] = 'must be a string';
      }
      if (body['confirm_reenable'] !== true) {
        fieldErrors['confirm_reenable'] = 'must be true';
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
          { details: { fields: fieldErrors }, retryable: false });
      }

      const sql = getSql();
      const merchant = await loadMerchantContext(sql, tenantId, request.params.merchantId);
      if (!merchant) {
        throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
      }
      if (merchant.agentic_commerce_enabled === true) {
        throw new CommerceHttpError(409, 'merchant_already_enabled',
          'Merchant agentic commerce is already enabled');
      }
      const activePolicy = await loadActivePolicy(sql, tenantId, request.params.merchantId);
      if (!activePolicy || activePolicy.id !== body['reviewed_policy_id']) {
        throw new CommerceHttpError(409, 'reviewed_policy_not_active',
          'Reviewed policy must match the merchant active policy');
      }

      const result = await sql.begin(async (_tx) => {
        const tx = _tx as unknown as TxSql;
        const rows = await tx<Array<{
          id: string;
          tenant_id: string;
          agentic_commerce_enabled: boolean;
          updated_at: Date | string;
        }>>`
          UPDATE commerce_merchants
             SET agentic_commerce_enabled = TRUE,
                 updated_at = NOW()
           WHERE id = ${request.params.merchantId}
             AND tenant_id = ${tenantId}
             AND agentic_commerce_enabled = FALSE
             AND disabled_at IS NULL
          RETURNING id, tenant_id, agentic_commerce_enabled, updated_at
        `;
        const updated = rows[0];
        if (!updated) return null;
        const audit = await appendCommerceAudit(tx as unknown as Sql, {
          tenantId,
          merchantId: updated.id,
          eventType: 'merchant.agentic_commerce_reenabled',
          resourceType: 'merchant',
          resourceId: updated.id,
          policyVersion: activePolicy.version,
          requestId: request.id,
          metadata: {
            flag: 'agentic_commerce_enabled',
            value: true,
            reason: body['reason'] as string,
            reviewed_policy_id: activePolicy.id,
            incident_reference: isString(body['incident_reference']) ? body['incident_reference'] : null,
            operator: actorId(request.commerceCaller),
            live_payments_enabled: false,
            plural_enabled: false,
          },
        });
        return { merchant: updated, auditEventId: audit.id };
      });
      if (!result) {
        throw new CommerceHttpError(409, 'merchant_reenable_conflict',
          'Merchant could not be re-enabled from the disabled agentic commerce state');
      }
      return reply.status(200).send({
        data: {
          merchant_id: result.merchant.id,
          agentic_commerce_enabled: result.merchant.agentic_commerce_enabled,
          disabled: false,
          reviewed_policy_id: activePolicy.id,
        },
        audit_event_id: result.auditEventId,
      });
    },
  );

  app.post<{ Body: PolicyEvaluateBody }>(
    '/policies/evaluate',
    { config: { rateLimit: { max: 1000, timeWindow: '1 minute' } } },
    async (request, reply) => {
    const tenantId = tenantIdOrThrow(request);
    const body = request.body ?? {};
    const fieldErrors: Record<string, string> = {};
    if (!isString(body.merchant_id)) fieldErrors['merchant_id'] = 'required string';
    if (!isString(body.agent_id)) fieldErrors['agent_id'] = 'required string';
    if (!isString(body.passport_jwt)) fieldErrors['passport_jwt'] = 'required string';
    const actionScopeRaw = body.action_scope ?? body.scope;
    if (!isCommercePolicyScope(actionScopeRaw)) {
      fieldErrors['action_scope'] = 'must be a supported commerce scope';
    }
    const amountMinorUnits = asInt(body.amount_minor_units);
    const currency = isString(body.currency) ? body.currency : null;
    if (isCommercePolicyScope(actionScopeRaw) && requiredAmountScope(actionScopeRaw)) {
      if (amountMinorUnits === null || amountMinorUnits < 0) {
        fieldErrors['amount_minor_units'] = 'required non-negative integer for payment-affecting actions';
      }
      if (!currency) fieldErrors['currency'] = 'required string for payment-affecting actions';
    } else if (body.amount_minor_units !== undefined && (amountMinorUnits === null || amountMinorUnits < 0)) {
      fieldErrors['amount_minor_units'] = 'must be a non-negative integer';
    }
    if (body.environment !== undefined && body.environment !== 'sandbox' && body.environment !== 'live') {
      fieldErrors['environment'] = 'must be sandbox or live';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new CommerceHttpError(422, 'validation_failed', 'Request validation failed',
        { details: { fields: fieldErrors }, retryable: false });
    }

    const merchantId = body.merchant_id as string;
    const agentId = body.agent_id as string;
    const actionScope = actionScopeRaw as CommercePolicyScope;
    requireEvaluatorScope(request, merchantId, agentId);

    const sql = getSql();
    const merchant = await loadMerchantContext(sql, tenantId, merchantId);
    if (!merchant) {
      throw new CommerceHttpError(404, 'merchant_not_found', 'Merchant not found in this tenant');
    }
    const agent = await loadAgentContext(sql, tenantId, agentId);
    const policy = await loadActivePolicy(sql, tenantId, merchantId);
    if (!policy) {
      throw new CommerceHttpError(409, 'policy_not_active',
        'No active commerce policy exists for this merchant');
    }

    const rules = validateRulesOrThrow(policy.rules);
    const decisionId = newCommercePolicyDecisionId();
    const resourceType = isString(body.resource_type) ? body.resource_type : null;
    const resourceId = isString(body.resource_id) ? body.resource_id : null;

    const deny = async (
      reason: string,
      decision: CommercePolicyDecision = 'deny',
      passportJti: string | null = null,
    ) => {
      const result = await sendPolicyDecision(sql, request, {
        decision,
        reason,
        tenantId,
        merchantId,
        agentId,
        passportJti,
        policy,
        decisionId,
        resourceType,
        resourceId,
      });
      return reply.status(200).send(result.body);
    };

    if (merchant.tenant_status !== 'active') return deny('tenant_disabled');
    if (merchant.disabled_at !== null || merchant.agentic_commerce_enabled !== true) {
      return deny('emergency_disabled');
    }
    if (!agent) return deny('agent_not_found');
    if (agent.disabled_at !== null || agent.trust_status === 'disabled') {
      return deny('agent_disabled');
    }
    if (agent.trust_status !== 'trusted') return deny('agent_not_trusted');

    const actionEnvironment = body.environment === 'live' ? 'live' : body.environment === 'sandbox'
      ? 'sandbox'
      : merchant.environment;
    if (actionEnvironment !== merchant.environment) {
      return deny('environment_mismatch');
    }

    let redis: import('ioredis').Redis | null = null;
    try { redis = getRedis(); } catch { redis = null; }
    const verified = await verifyCommercePassport(sql, redis, body.passport_jwt as string, {
      mode: 'payment_affecting',
      expectedTenantId: tenantId,
      expectedMerchantId: merchantId,
    });
    if (!verified.ok) {
      return deny(passportFailureReason(verified.error));
    }
    const passport: VerifiedPassport = verified.passport;
    if (passport.agentId !== agentId) return deny('agent_mismatch', 'deny', passport.jti);
    if (passport.environment !== actionEnvironment) return deny('environment_mismatch', 'deny', passport.jti);
    if (requiredAmountScope(actionScope) && passport.passportType !== 'checkout') {
      return deny('checkout_passport_required', 'deny', passport.jti);
    }
    if (passportTtlExceeded(passport, rules)) {
      return deny(`${passport.passportType}_passport_ttl_exceeded`, 'deny', passport.jti);
    }

    const evaluation = evaluateCommercePolicyRules(rules, {
      actionScope,
      amountMinorUnits: amountMinorUnits !== null ? amountMinorUnits : null,
      currency,
      passportScopes: passport.scopes,
      passportMaxAmount: passport.maxAmount,
      passportCurrency: passport.currency,
    });

    const result = await sendPolicyDecision(sql, request, {
      decision: evaluation.decision,
      reason: evaluation.reason,
      tenantId,
      merchantId,
      agentId,
      passportJti: passport.jti,
      policy,
      decisionId,
      resourceType,
      resourceId,
    });
    return reply.status(200).send(result.body);
    },
  );
}
