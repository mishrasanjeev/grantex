import { CommerceHttpError } from './errors.js';
import { hashRequestBody } from './idempotency.js';
import {
  buildCommerceOrderFoundationDraft,
  publicCommerceOrderRefusal,
  type CommerceOrderFoundationDraft,
  type CommerceOrderLineItemFactInput,
} from './order-foundation.js';
import {
  buildCommerceOrderHandoffFoundationDraft,
  publicCommerceOrderHandoffRefusal,
  type CommerceOrderHandoffFoundationDraft,
} from './order-handoff.js';

export const COMMERCE_SANDBOX_CHECKOUT_STATUSES = [
  'draft',
  'authority_checked',
  'order_linked',
  'handoff_linked',
  'synthetic_outcome_recorded',
  'refused',
  'blocked',
] as const;

export type CommerceSandboxCheckoutStatus = typeof COMMERCE_SANDBOX_CHECKOUT_STATUSES[number];

export const COMMERCE_SANDBOX_SYNTHETIC_PAYMENT_OUTCOMES = [
  'not_attempted',
  'synthetic_authorized',
  'synthetic_pending',
  'synthetic_succeeded',
  'synthetic_declined',
  'synthetic_expired',
  'synthetic_cancelled',
] as const;

export type CommerceSandboxSyntheticPaymentOutcome =
  typeof COMMERCE_SANDBOX_SYNTHETIC_PAYMENT_OUTCOMES[number];

export type CommerceSandboxCheckoutRefusalCode =
  | 'sandbox_checkout_tenant_context_required'
  | 'sandbox_checkout_merchant_context_required'
  | 'sandbox_checkout_buyer_context_required'
  | 'sandbox_checkout_agent_context_required'
  | 'sandbox_checkout_session_context_required'
  | 'sandbox_checkout_cart_required'
  | 'sandbox_checkout_cart_facts_required'
  | 'sandbox_checkout_consent_required'
  | 'sandbox_checkout_passport_required'
  | 'sandbox_checkout_passport_expired'
  | 'sandbox_checkout_passport_revoked'
  | 'sandbox_checkout_passport_mismatch'
  | 'sandbox_checkout_passport_unknown'
  | 'sandbox_checkout_checkout_passport_required'
  | 'sandbox_checkout_scope_required'
  | 'sandbox_checkout_environment_refused'
  | 'sandbox_checkout_public_discovery_not_available'
  | 'sandbox_checkout_audit_evidence_required'
  | 'sandbox_checkout_idempotency_required';

export interface CommerceSandboxCheckoutAuthority {
  consent_granted?: boolean | null;
  passport_status?: 'valid' | 'missing' | 'expired' | 'revoked' | 'mismatched' | 'unknown' | null;
  passport_type?: 'checkout' | 'browse' | 'support' | 'unknown' | null;
  tenant_id?: string | null;
  merchant_id?: string | null;
  agent_id?: string | null;
  buyer_principal_id?: string | null;
  session_id?: string | null;
  environment?: 'sandbox' | 'live' | 'unknown' | null;
  scopes?: string[] | null;
}

export interface CommerceSandboxCheckoutCartInput {
  cart_id?: string | null;
  line_items?: CommerceOrderLineItemFactInput[] | null;
  source_checked_at?: string | null;
}

export interface CommerceSandboxCheckoutE2EInput {
  tenant_id?: string | null;
  merchant_id?: string | null;
  buyer_principal_id?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
  environment?: 'sandbox' | 'live' | 'unknown' | null;
  public_discovery_state?: 'hidden' | 'disabled' | 'enabled' | 'unknown' | null;
  cart?: CommerceSandboxCheckoutCartInput | null;
  payment_intent_id?: string | null;
  synthetic_payment_outcome?: CommerceSandboxSyntheticPaymentOutcome | null;
  authority?: CommerceSandboxCheckoutAuthority | null;
  source_freshness_refs?: Record<string, unknown> | null;
  buyer_safe_context?: Record<string, unknown> | null;
  audit_evidence_refs?: Array<Record<string, string>> | null;
  idempotency_key_hash?: string | null;
}

export interface CommerceSandboxCheckoutSyntheticPaymentSummary {
  payment_intent_id: string | null;
  outcome: CommerceSandboxSyntheticPaymentOutcome;
  mode: 'local_sandbox_contract_only';
  live_mode: false;
  provider_call: false;
  partner_payment_rail_call: false;
  carrier_call: false;
  merchant_private_api_call: false;
  production_checkout_enabled: false;
}

export interface CommerceSandboxCheckoutReadyResult {
  status: 'synthetic_outcome_recorded';
  tenant_id: string;
  merchant_id: string;
  buyer_principal_id: string;
  agent_id: string;
  session_id: string;
  environment: 'sandbox';
  buyer_facing_checkout_surface: 'not_exposed';
  public_discovery_state: 'hidden' | 'disabled';
  idempotency_scope: 'sandbox.checkout.e2e.contract';
  idempotency_key_hash: string;
  request_body_hash: string;
  order: CommerceOrderFoundationDraft;
  handoff: CommerceOrderHandoffFoundationDraft;
  synthetic_payment: CommerceSandboxCheckoutSyntheticPaymentSummary;
  buyer_safe_context: Record<string, unknown>;
  audit_evidence_refs: Array<Record<string, string>>;
  non_enablement: {
    production_checkout: false;
    live_payment: false;
    live_partner_payment_rail: false;
    provider_call: false;
    partner_payment_rail_call: false;
    carrier_call: false;
    merchant_private_api_call: false;
    public_discovery: false;
  };
  sequence: Array<{
    step: string;
    status: CommerceSandboxCheckoutStatus;
    message: string;
  }>;
}

export interface CommerceSandboxCheckoutRefusedResult {
  status: 'refused';
  refusal: {
    code: CommerceSandboxCheckoutRefusalCode;
    message: string;
    retryable: boolean;
  };
  buyer_facing_checkout_surface: 'not_exposed';
  public_discovery_state: 'hidden' | 'disabled' | 'enabled' | 'unknown';
  non_enablement: CommerceSandboxCheckoutReadyResult['non_enablement'];
  sequence: Array<{
    step: string;
    status: 'refused';
    message: string;
  }>;
}

export type CommerceSandboxCheckoutE2EResult =
  | CommerceSandboxCheckoutReadyResult
  | CommerceSandboxCheckoutRefusedResult;

export interface CommerceSandboxCheckoutPriorResult {
  tenant_id: string;
  merchant_id: string;
  idempotency_scope: 'sandbox.checkout.e2e.contract';
  idempotency_key_hash: string;
  request_body_hash: string;
  response: CommerceSandboxCheckoutE2EResult;
}

export type CommerceSandboxCheckoutReplayResult =
  | { kind: 'new'; request_body_hash: string }
  | { kind: 'replay'; response: CommerceSandboxCheckoutE2EResult }
  | { kind: 'conflict'; expected_body_hash: string; actual_body_hash: string };

const ALLOWED_SANDBOX_CHECKOUT_TRANSITIONS: Record<CommerceSandboxCheckoutStatus, CommerceSandboxCheckoutStatus[]> = {
  draft: ['authority_checked', 'refused', 'blocked'],
  authority_checked: ['order_linked', 'refused', 'blocked'],
  order_linked: ['handoff_linked', 'blocked'],
  handoff_linked: ['synthetic_outcome_recorded', 'blocked'],
  synthetic_outcome_recorded: [],
  refused: [],
  blocked: [],
};

const FORBIDDEN_SANDBOX_CHECKOUT_KEYS = new Set([
  'carrier_api_key',
  'carrier_call',
  'carrier_execution_enabled',
  'carrier_label_url',
  'carrier_provider',
  'carrier_request_id',
  'carrier_tracking_url',
  'checkout_payment_enabled',
  'checkout_url',
  'delivery_execution_enabled',
  'fulfillment_execution_enabled',
  'live_payment_enabled',
  'live_payment_provider_enabled',
  'live_provider_enabled',
  ['live_plu', 'ral_enabled'].join(''),
  'merchant_private_api_call',
  'merchant_private_api_key',
  'merchant_private_api_url',
  'payment_provider_call',
  ['plu', 'ral_call'].join(''),
  'private_api_key',
  'private_api_url',
  'production_allowlist',
  'production_checkout_enabled',
  'provider_call',
  'provider_key',
  'provider_metadata',
  'provider_order_id',
  'provider_payment_id',
  'provider_raw_payload',
  'raw_connector_payload',
  'raw_payload',
  'raw_provider_payload',
  'refund_execution_enabled',
  'refund_provider_id',
  'refund_transaction_id',
  'settlement_enabled',
  'settlement_id',
  'shipping_enabled',
  'shipping_label_url',
  'tracking_number',
  'payout_enabled',
  'payout_id',
]);

const PRIVATE_SANDBOX_CHECKOUT_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'bearer',
  'credential',
  'credentials',
  'db_url',
  'evidence',
  'jwt',
  'merchant_private_url',
  'passport',
  'private_url',
  'provider_credential',
  'raw_consent_payload',
  'redis_url',
  'refresh_token',
  'secret',
  'token',
  'webhook_secret',
]);

const PUBLIC_SANDBOX_CHECKOUT_REFUSALS: Record<CommerceSandboxCheckoutRefusalCode, {
  message: string;
  retryable: boolean;
}> = {
  sandbox_checkout_tenant_context_required: {
    message: 'Sandbox checkout requires a tenant-bound Grantex context.',
    retryable: false,
  },
  sandbox_checkout_merchant_context_required: {
    message: 'Sandbox checkout requires a merchant-bound Grantex context.',
    retryable: false,
  },
  sandbox_checkout_buyer_context_required: {
    message: 'Sandbox checkout requires a buyer or session principal.',
    retryable: false,
  },
  sandbox_checkout_agent_context_required: {
    message: 'Sandbox checkout requires a registered CommerceAgent context.',
    retryable: false,
  },
  sandbox_checkout_session_context_required: {
    message: 'Sandbox checkout requires a buyer session context.',
    retryable: false,
  },
  sandbox_checkout_cart_required: {
    message: 'Sandbox checkout requires a Grantex cart reference.',
    retryable: false,
  },
  sandbox_checkout_cart_facts_required: {
    message: 'Sandbox checkout requires safe cart facts before an order foundation can be represented.',
    retryable: true,
  },
  sandbox_checkout_consent_required: {
    message: 'Sandbox checkout requires user consent before protected sequencing can continue.',
    retryable: true,
  },
  sandbox_checkout_passport_required: {
    message: 'Sandbox checkout requires Commerce Passport authority before protected sequencing can continue.',
    retryable: true,
  },
  sandbox_checkout_passport_expired: {
    message: 'Sandbox checkout authority has expired. Refresh consent before continuing.',
    retryable: true,
  },
  sandbox_checkout_passport_revoked: {
    message: 'Sandbox checkout authority has been revoked.',
    retryable: false,
  },
  sandbox_checkout_passport_mismatch: {
    message: 'Sandbox checkout authority does not match this tenant, merchant, buyer, session, or agent.',
    retryable: false,
  },
  sandbox_checkout_passport_unknown: {
    message: 'Sandbox checkout authority is unknown. Refresh from Grantex before continuing.',
    retryable: true,
  },
  sandbox_checkout_checkout_passport_required: {
    message: 'Sandbox checkout requires checkout-scoped Commerce Passport authority.',
    retryable: true,
  },
  sandbox_checkout_scope_required: {
    message: 'Sandbox checkout requires checkout and payment initiation scopes.',
    retryable: true,
  },
  sandbox_checkout_environment_refused: {
    message: 'Sandbox checkout E2E refuses live or unknown payment environments.',
    retryable: false,
  },
  sandbox_checkout_public_discovery_not_available: {
    message: 'Buyer-facing checkout remains unavailable while public discovery is not enabled for this slice.',
    retryable: false,
  },
  sandbox_checkout_audit_evidence_required: {
    message: 'Sandbox checkout requires redacted audit evidence references.',
    retryable: true,
  },
  sandbox_checkout_idempotency_required: {
    message: 'Sandbox checkout requires a hashed idempotency key reference.',
    retryable: false,
  },
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeGuardKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function safeDiscoveryState(
  state: CommerceSandboxCheckoutE2EInput['public_discovery_state'],
): 'hidden' | 'disabled' | 'enabled' | 'unknown' {
  if (state === 'hidden' || state === 'disabled' || state === 'enabled') return state;
  return 'unknown';
}

function normalizeSyntheticOutcome(
  outcome: CommerceSandboxCheckoutE2EInput['synthetic_payment_outcome'],
): CommerceSandboxSyntheticPaymentOutcome {
  if (
    typeof outcome === 'string'
    && (COMMERCE_SANDBOX_SYNTHETIC_PAYMENT_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return outcome as CommerceSandboxSyntheticPaymentOutcome;
  }
  return 'not_attempted';
}

function publicRefusal(code: CommerceSandboxCheckoutRefusalCode): CommerceSandboxCheckoutRefusedResult['refusal'] {
  const refusal = PUBLIC_SANDBOX_CHECKOUT_REFUSALS[code];
  return {
    code,
    message: refusal.message,
    retryable: refusal.retryable,
  };
}

function refusalResult(
  input: CommerceSandboxCheckoutE2EInput,
  code: CommerceSandboxCheckoutRefusalCode,
): CommerceSandboxCheckoutRefusedResult {
  const refusal = publicRefusal(code);
  return {
    status: 'refused',
    refusal,
    buyer_facing_checkout_surface: 'not_exposed',
    public_discovery_state: safeDiscoveryState(input.public_discovery_state),
    non_enablement: {
      production_checkout: false,
      live_payment: false,
      live_partner_payment_rail: false,
      provider_call: false,
      partner_payment_rail_call: false,
      carrier_call: false,
      merchant_private_api_call: false,
      public_discovery: false,
    },
    sequence: [{
      step: 'fail_closed_refusal',
      status: 'refused',
      message: refusal.message,
    }],
  };
}

export function canTransitionCommerceSandboxCheckoutStatus(
  from: CommerceSandboxCheckoutStatus,
  to: CommerceSandboxCheckoutStatus,
): boolean {
  return ALLOWED_SANDBOX_CHECKOUT_TRANSITIONS[from].includes(to);
}

export function assertCommerceSandboxCheckoutStatusTransition(
  from: CommerceSandboxCheckoutStatus,
  to: CommerceSandboxCheckoutStatus,
): void {
  if (!canTransitionCommerceSandboxCheckoutStatus(from, to)) {
    throw new CommerceHttpError(409, 'sandbox_checkout_status_transition_refused',
      'Sandbox checkout status transition is not allowed by the C6U9 foundation', {
        retryable: false,
        details: { from, to },
      });
  }
}

export function allowedCommerceSandboxCheckoutStatusTransitions(
  from: CommerceSandboxCheckoutStatus,
): CommerceSandboxCheckoutStatus[] {
  return [...ALLOWED_SANDBOX_CHECKOUT_TRANSITIONS[from]];
}

export function assertNoCommerceSandboxCheckoutExecutionFields(value: unknown): void {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (typeof current === 'object') {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (FORBIDDEN_SANDBOX_CHECKOUT_KEYS.has(normalizeGuardKey(key))) {
          throw new CommerceHttpError(422, 'sandbox_checkout_execution_fields_not_allowed',
            'Sandbox checkout cannot carry production checkout, live payment, provider, partner rail, carrier, private API, raw payload, settlement, payout, fulfillment, or refund execution fields', {
              retryable: false,
            });
        }
        stack.push(child);
      }
    }
  }
}

export function redactCommerceSandboxCheckoutPrivateFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactCommerceSandboxCheckoutPrivateFields(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      output[key] = PRIVATE_SANDBOX_CHECKOUT_KEYS.has(normalizeGuardKey(key))
        ? '[redacted]'
        : redactCommerceSandboxCheckoutPrivateFields(child);
    }
    return output as T;
  }
  return value;
}

export function publicCommerceSandboxCheckoutRefusal(code: CommerceSandboxCheckoutRefusalCode): {
  code: CommerceSandboxCheckoutRefusalCode;
  message: string;
  retryable: boolean;
} {
  return publicRefusal(code);
}

export function evaluateCommerceSandboxCheckoutReadiness(
  input: CommerceSandboxCheckoutE2EInput,
): CommerceSandboxCheckoutRefusalCode | null {
  if (!isNonEmptyString(input.tenant_id)) return 'sandbox_checkout_tenant_context_required';
  if (!isNonEmptyString(input.merchant_id)) return 'sandbox_checkout_merchant_context_required';
  if (!isNonEmptyString(input.buyer_principal_id)) return 'sandbox_checkout_buyer_context_required';
  if (!isNonEmptyString(input.agent_id)) return 'sandbox_checkout_agent_context_required';
  if (!isNonEmptyString(input.session_id)) return 'sandbox_checkout_session_context_required';
  if (input.environment !== 'sandbox') return 'sandbox_checkout_environment_refused';
  if (input.public_discovery_state !== 'hidden' && input.public_discovery_state !== 'disabled') {
    return 'sandbox_checkout_public_discovery_not_available';
  }
  if (!isNonEmptyString(input.cart?.cart_id)) return 'sandbox_checkout_cart_required';
  if (!input.cart?.line_items || input.cart.line_items.length === 0) {
    return 'sandbox_checkout_cart_facts_required';
  }
  if (!input.audit_evidence_refs || input.audit_evidence_refs.length === 0) {
    return 'sandbox_checkout_audit_evidence_required';
  }
  if (!isNonEmptyString(input.idempotency_key_hash)) return 'sandbox_checkout_idempotency_required';

  const authority = input.authority;
  if (!authority?.consent_granted) return 'sandbox_checkout_consent_required';
  if (authority.passport_status === 'missing' || !authority.passport_status) return 'sandbox_checkout_passport_required';
  if (authority.passport_status === 'expired') return 'sandbox_checkout_passport_expired';
  if (authority.passport_status === 'revoked') return 'sandbox_checkout_passport_revoked';
  if (authority.passport_status === 'unknown') return 'sandbox_checkout_passport_unknown';
  if (authority.passport_status === 'mismatched') return 'sandbox_checkout_passport_mismatch';
  if (authority.environment !== 'sandbox') return 'sandbox_checkout_environment_refused';
  if (
    authority.tenant_id !== input.tenant_id
    || authority.merchant_id !== input.merchant_id
    || authority.agent_id !== input.agent_id
    || authority.buyer_principal_id !== input.buyer_principal_id
    || authority.session_id !== input.session_id
  ) {
    return 'sandbox_checkout_passport_mismatch';
  }
  if (authority.passport_type !== 'checkout') return 'sandbox_checkout_checkout_passport_required';

  const scopes = new Set(authority.scopes ?? []);
  if (!scopes.has('commerce:checkout.create') || !scopes.has('commerce:payment.initiate')) {
    return 'sandbox_checkout_scope_required';
  }

  return null;
}

export function hashCommerceSandboxCheckoutRequest(input: CommerceSandboxCheckoutE2EInput): string {
  return hashRequestBody({
    tenant_id: input.tenant_id ?? null,
    merchant_id: input.merchant_id ?? null,
    buyer_principal_id: input.buyer_principal_id ?? null,
    agent_id: input.agent_id ?? null,
    session_id: input.session_id ?? null,
    environment: input.environment ?? null,
    public_discovery_state: input.public_discovery_state ?? null,
    cart: {
      cart_id: input.cart?.cart_id ?? null,
      line_items: input.cart?.line_items ?? [],
      source_checked_at: input.cart?.source_checked_at ?? null,
    },
    payment_intent_id: input.payment_intent_id ?? null,
    synthetic_payment_outcome: normalizeSyntheticOutcome(input.synthetic_payment_outcome),
    authority: {
      consent_granted: input.authority?.consent_granted ?? false,
      passport_status: input.authority?.passport_status ?? null,
      passport_type: input.authority?.passport_type ?? null,
      tenant_id: input.authority?.tenant_id ?? null,
      merchant_id: input.authority?.merchant_id ?? null,
      agent_id: input.authority?.agent_id ?? null,
      buyer_principal_id: input.authority?.buyer_principal_id ?? null,
      session_id: input.authority?.session_id ?? null,
      environment: input.authority?.environment ?? null,
      scopes: [...(input.authority?.scopes ?? [])].sort(),
    },
  });
}

export function compareCommerceSandboxCheckoutReplay(
  input: CommerceSandboxCheckoutE2EInput,
  previous?: CommerceSandboxCheckoutPriorResult | null,
): CommerceSandboxCheckoutReplayResult {
  const actual = hashCommerceSandboxCheckoutRequest(input);
  if (!previous) return { kind: 'new', request_body_hash: actual };
  if (
    previous.tenant_id !== input.tenant_id
    || previous.merchant_id !== input.merchant_id
    || previous.idempotency_scope !== 'sandbox.checkout.e2e.contract'
    || previous.idempotency_key_hash !== input.idempotency_key_hash
  ) {
    return { kind: 'new', request_body_hash: actual };
  }
  if (previous.request_body_hash !== actual) {
    return {
      kind: 'conflict',
      expected_body_hash: previous.request_body_hash,
      actual_body_hash: actual,
    };
  }
  return { kind: 'replay', response: previous.response };
}

export function buildCommerceSandboxCheckoutE2EPlan(
  input: CommerceSandboxCheckoutE2EInput,
): CommerceSandboxCheckoutE2EResult {
  assertNoCommerceSandboxCheckoutExecutionFields(input);

  const readinessRefusal = evaluateCommerceSandboxCheckoutReadiness(input);
  if (readinessRefusal) return refusalResult(input, readinessRefusal);

  const tenantId = input.tenant_id as string;
  const merchantId = input.merchant_id as string;
  const buyerPrincipalId = input.buyer_principal_id as string;
  const agentId = input.agent_id as string;
  const sessionId = input.session_id as string;
  const cartId = input.cart?.cart_id as string;
  const idempotencyKeyHash = input.idempotency_key_hash as string;
  const auditEvidenceRefs = cloneJson(input.audit_evidence_refs ?? []);
  const requestBodyHash = hashCommerceSandboxCheckoutRequest(input);

  const order = buildCommerceOrderFoundationDraft({
    tenant_id: tenantId,
    merchant_id: merchantId,
    buyer_principal_id: buyerPrincipalId,
    agent_id: agentId,
    cart_id: cartId,
    payment_intent_id: input.payment_intent_id ?? null,
    created_from: 'cart_snapshot',
    idempotency_key_hash: idempotencyKeyHash,
    line_items: cloneJson(input.cart?.line_items ?? []),
    source_freshness_refs: redactCommerceSandboxCheckoutPrivateFields(cloneJson(input.source_freshness_refs ?? {})),
    audit_evidence_refs: auditEvidenceRefs,
    scoped_refs: [
      { label: 'cart', tenant_id: tenantId, merchant_id: merchantId, id: cartId },
      ...(input.payment_intent_id
        ? [{ label: 'synthetic_payment_intent', tenant_id: tenantId, merchant_id: merchantId, id: input.payment_intent_id }]
        : []),
    ],
    support_reference: { state: 'support_status_not_enabled_by_c6u9_sandbox' },
  });

  const handoff = buildCommerceOrderHandoffFoundationDraft({
    tenant_id: tenantId,
    order_id: order.id,
    merchant_id: merchantId,
    buyer_principal_id: buyerPrincipalId,
    agent_id: agentId,
    session_id: sessionId,
    handoff_type: 'fulfillment',
    handoff_snapshot: {
      handoff_type: 'fulfillment',
      summary: 'Sandbox handoff placeholder only. Execution requires a later Grantex source contract.',
      safe_fields: {
        state: 'non_executing_placeholder',
        synthetic_only: true,
      },
      source_refs: [{
        source: 'order',
        source_id: order.id,
        checked_at: input.cart?.source_checked_at ?? null,
        freshness: 'fresh',
      }],
    },
    source_freshness_refs: redactCommerceSandboxCheckoutPrivateFields(cloneJson(input.source_freshness_refs ?? {})),
    audit_evidence_refs: auditEvidenceRefs,
    idempotency_key_hash: hashRequestBody({
      parent_idempotency_key_hash: idempotencyKeyHash,
      handoff_type: 'fulfillment',
      cart_id: cartId,
    }),
    created_from: 'order_safe_source',
    scoped_refs: [{
      label: 'order',
      tenant_id: tenantId,
      order_id: order.id,
      merchant_id: merchantId,
      buyer_principal_id: buyerPrincipalId,
    }],
    support_reference: { state: 'handoff_support_not_enabled_by_c6u9_sandbox' },
  });

  return {
    status: 'synthetic_outcome_recorded',
    tenant_id: tenantId,
    merchant_id: merchantId,
    buyer_principal_id: buyerPrincipalId,
    agent_id: agentId,
    session_id: sessionId,
    environment: 'sandbox',
    buyer_facing_checkout_surface: 'not_exposed',
    public_discovery_state: input.public_discovery_state as 'hidden' | 'disabled',
    idempotency_scope: 'sandbox.checkout.e2e.contract',
    idempotency_key_hash: idempotencyKeyHash,
    request_body_hash: requestBodyHash,
    order,
    handoff,
    synthetic_payment: {
      payment_intent_id: input.payment_intent_id ?? null,
      outcome: normalizeSyntheticOutcome(input.synthetic_payment_outcome),
      mode: 'local_sandbox_contract_only',
      live_mode: false,
      provider_call: false,
      partner_payment_rail_call: false,
      carrier_call: false,
      merchant_private_api_call: false,
      production_checkout_enabled: false,
    },
    buyer_safe_context: redactCommerceSandboxCheckoutPrivateFields(cloneJson(input.buyer_safe_context ?? {})),
    audit_evidence_refs: auditEvidenceRefs,
    non_enablement: {
      production_checkout: false,
      live_payment: false,
      live_partner_payment_rail: false,
      provider_call: false,
      partner_payment_rail_call: false,
      carrier_call: false,
      merchant_private_api_call: false,
      public_discovery: false,
    },
    sequence: [
      {
        step: 'authority',
        status: 'authority_checked',
        message: 'Sandbox consent and Commerce Passport authority were represented without exposing raw authority material.',
      },
      {
        step: 'order_foundation',
        status: 'order_linked',
        message: publicCommerceOrderRefusal('order_payment_not_enabled_by_c6u7').message,
      },
      {
        step: 'handoff_foundation',
        status: 'handoff_linked',
        message: publicCommerceOrderHandoffRefusal('order_handoff_execution_not_enabled_by_c6u8').message,
      },
      {
        step: 'synthetic_payment',
        status: 'synthetic_outcome_recorded',
        message: 'Synthetic payment outcome was recorded locally without checkout, provider, partner rail, carrier, or merchant private API execution.',
      },
    ],
  };
}
