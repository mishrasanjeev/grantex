import { describe, expect, it } from 'vitest';
import {
  computeSandboxAgentFacingPreview,
  computeSandboxOnboardingReadiness,
  toSandboxAgenticOrgBuyerDiscoveryPreviewResponse,
  type SandboxOnboardingCatalogSummary,
  type SandboxOnboardingMerchant,
  type SandboxReadOnlyDiscoveryReviewAuditSnapshot,
} from '../src/lib/commerce/sandbox-onboarding.js';

const now = new Date('2026-06-09T00:00:00.000Z');

const PUBLIC_DISCOVERY_STATES = [
  'hidden',
  'draft',
  'sandbox_review',
  'approved_for_sandbox_preview',
  'blocked',
  'rejected',
  'expired',
  'production_pending',
  'future_public_enabled',
] as const;

type PublicDiscoveryState = typeof PUBLIC_DISCOVERY_STATES[number];

interface PublicDiscoveryEvidence {
  grantex_review: boolean;
  agenticorg_review: boolean;
  source_freshness: boolean;
  rollback_owner: boolean;
  expires_at?: string;
  synthetic_demo?: boolean;
}

interface PublicDiscoveryDecision {
  grantex_state: PublicDiscoveryState | 'missing' | 'unsupported';
  agenticorg_state: PublicDiscoveryState | 'missing' | 'unsupported';
  public_discovery_enabled: false;
  buyer_visibility: 'hidden' | 'internal_preview';
  refusal_code: string;
  blockers: string[];
}

function merchant(overrides: Partial<SandboxOnboardingMerchant> = {}): SandboxOnboardingMerchant {
  return {
    id: 'merchant_synthetic_c6u5',
    tenant_id: 'tenant_synthetic_c6u5',
    display_name: 'Synthetic Public Discovery Merchant',
    category_preset: 'electronics_appliances',
    environment: 'sandbox',
    agentic_commerce_enabled: false,
    agentic_commerce_requested: true,
    sandbox_onboarding_state: 'submitted_for_review',
    default_currency: 'INR',
    country_code: 'IN',
    support_email: 'support@example.test',
    support_url: null,
    public_discovery_description_draft: 'Synthetic sandbox catalog preview for internal buyer-agent review.',
    provider_account_refs: null,
    ...overrides,
  };
}

function readyCatalogSummary(overrides: Partial<SandboxOnboardingCatalogSummary> = {}): SandboxOnboardingCatalogSummary {
  return {
    product_count: 1,
    variant_count: 1,
    products_with_image: 1,
    products_with_public_safe_title: 1,
    products_with_public_safe_description: 1,
    products_with_category_mapping: 1,
    products_with_unsafe_text: 0,
    variants_with_sku: 1,
    variants_with_price_currency: 1,
    variants_with_warranty_summary: 1,
    variants_with_return_policy_summary: 1,
    variants_with_tax_metadata: 1,
    variants_with_fresh_inventory: 1,
    variants_with_known_availability: 1,
    variants_with_unsafe_text: 0,
    ...overrides,
  };
}

function sampleProducts() {
  return [{
    title: 'Synthetic Lamp',
    description: 'Synthetic public-safe preview item.',
    image_url: 'https://example.test/images/lamp.png',
    category_preset: 'electronics_appliances',
    variants: [{
      sku: 'SKU-C6U5-LAMP',
      variant_title: 'Warm finish',
      price_amount: 1299,
      currency: 'INR',
      availability_status: 'in_stock',
      warranty_summary: 'Synthetic one-year limited warranty summary.',
      return_policy_summary: 'Synthetic seven-day unopened return summary.',
    }],
  }];
}

function audit(
  event_type: string,
  audit_event_id: string,
  metadata: Record<string, unknown> = {},
): SandboxReadOnlyDiscoveryReviewAuditSnapshot {
  return {
    audit_event_id,
    event_type,
    occurred_at: now.toISOString(),
    actor: 'operator_c6u5',
    metadata,
  };
}

function isKnownState(value: unknown): value is PublicDiscoveryState {
  return typeof value === 'string' && (PUBLIC_DISCOVERY_STATES as readonly string[]).includes(value);
}

function classifySharedPublicDiscoveryState(
  grantexState: unknown,
  agenticorgState: unknown,
  evidence: PublicDiscoveryEvidence,
): PublicDiscoveryDecision {
  const blockers: string[] = [];
  const grantex_state = grantexState === undefined || grantexState === null
    ? 'missing'
    : isKnownState(grantexState)
      ? grantexState
      : 'unsupported';
  const agenticorg_state = agenticorgState === undefined || agenticorgState === null
    ? 'missing'
    : isKnownState(agenticorgState)
      ? agenticorgState
      : 'unsupported';

  if (grantex_state === 'missing' || agenticorg_state === 'missing') blockers.push('state_missing');
  if (grantex_state === 'unsupported' || agenticorg_state === 'unsupported') blockers.push('state_unsupported');
  if (isKnownState(grantex_state) && isKnownState(agenticorg_state) && grantex_state !== agenticorg_state) {
    blockers.push('state_mismatch');
  }
  if (!evidence.grantex_review) blockers.push('grantex_review_evidence_missing');
  if (!evidence.agenticorg_review) blockers.push('agenticorg_review_evidence_missing');
  if (!evidence.source_freshness) blockers.push('source_freshness_evidence_missing');
  if (!evidence.rollback_owner) blockers.push('rollback_owner_missing');
  if (evidence.synthetic_demo) blockers.push('synthetic_demo_not_production_approval');
  if (evidence.expires_at && Date.parse(evidence.expires_at) <= now.getTime()) blockers.push('state_expired');
  if (isKnownState(grantex_state) && ['blocked', 'rejected', 'expired'].includes(grantex_state)) {
    blockers.push(`grantex_${grantex_state}`);
  }
  if (isKnownState(agenticorg_state) && ['blocked', 'rejected', 'expired'].includes(agenticorg_state)) {
    blockers.push(`agenticorg_${agenticorg_state}`);
  }
  if (isKnownState(grantex_state) && grantex_state === 'future_public_enabled') {
    blockers.push('future_public_enabled_not_enabled_by_c6u5');
  }

  const internalPreview = blockers.length === 0
    && grantex_state === 'approved_for_sandbox_preview'
    && agenticorg_state === 'approved_for_sandbox_preview';
  return {
    grantex_state,
    agenticorg_state,
    public_discovery_enabled: false,
    buyer_visibility: internalPreview ? 'internal_preview' : 'hidden',
    refusal_code: internalPreview ? 'public_discovery_not_enabled' : blockers[0] ?? 'public_discovery_not_enabled',
    blockers,
  };
}

describe('C6U5 shared public discovery state contract', () => {
  it('classifies every canonical state deterministically without enabling public discovery', () => {
    for (const state of PUBLIC_DISCOVERY_STATES) {
      const decision = classifySharedPublicDiscoveryState(state, state, {
        grantex_review: true,
        agenticorg_review: true,
        source_freshness: true,
        rollback_owner: true,
        expires_at: '2026-06-10T00:00:00.000Z',
      });

      expect(decision.grantex_state).toBe(state);
      expect(decision.agenticorg_state).toBe(state);
      expect(decision.public_discovery_enabled).toBe(false);
      if (state === 'approved_for_sandbox_preview') {
        expect(decision.buyer_visibility).toBe('internal_preview');
        expect(decision.refusal_code).toBe('public_discovery_not_enabled');
      } else {
        expect(decision.buyer_visibility).toBe('hidden');
      }
      if (state === 'future_public_enabled') {
        expect(decision.blockers).toContain('future_public_enabled_not_enabled_by_c6u5');
      }
    }
  });

  it('fails closed for missing, unknown, mismatched, expired, or synthetic-demo state', () => {
    expect(classifySharedPublicDiscoveryState(undefined, 'hidden', {
      grantex_review: true,
      agenticorg_review: true,
      source_freshness: true,
      rollback_owner: true,
    })).toMatchObject({ public_discovery_enabled: false, refusal_code: 'state_missing' });

    expect(classifySharedPublicDiscoveryState('made_public_elsewhere', 'hidden', {
      grantex_review: true,
      agenticorg_review: true,
      source_freshness: true,
      rollback_owner: true,
    })).toMatchObject({ public_discovery_enabled: false, refusal_code: 'state_unsupported' });

    expect(classifySharedPublicDiscoveryState('approved_for_sandbox_preview', 'hidden', {
      grantex_review: true,
      agenticorg_review: true,
      source_freshness: true,
      rollback_owner: true,
    })).toMatchObject({ public_discovery_enabled: false, refusal_code: 'state_mismatch' });

    expect(classifySharedPublicDiscoveryState('approved_for_sandbox_preview', 'approved_for_sandbox_preview', {
      grantex_review: true,
      agenticorg_review: true,
      source_freshness: true,
      rollback_owner: true,
      expires_at: '2026-06-08T00:00:00.000Z',
      synthetic_demo: true,
    })).toMatchObject({
      public_discovery_enabled: false,
      buyer_visibility: 'hidden',
      refusal_code: 'synthetic_demo_not_production_approval',
    });
  });

  it('keeps current Grantex preview and AgenticOrg handoff surfaces non-enabling', () => {
    const readiness = computeSandboxOnboardingReadiness(merchant(), {}, readyCatalogSummary());
    const agentPreview = computeSandboxAgentFacingPreview(merchant(), readiness, sampleProducts(), now);
    const handoff = toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
      merchant(),
      readiness,
      sampleProducts(),
      audit('merchant.sandbox_onboarding.read_only_discovery_review.requested', 'audit_c6u5_review_request'),
      audit('merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready', 'audit_c6u5_review_ready'),
      audit('merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed', 'audit_c6u5_dry_run'),
      audit('merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested', 'audit_c6u5_handoff', {
        handoff_requested_at: now.toISOString(),
        handoff_request_actor: 'operator_c6u5',
      }),
      now,
    );

    expect(agentPreview).toMatchObject({
      preview_status: 'ready',
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      production_approval_status: 'not_approved',
      rollout_status: 'rollout_not_requested',
    });
    expect(agentPreview.live_plural_enabled).toBe(false);
    expect(agentPreview.blocked_capabilities).toContain('public_discovery');
    expect(agentPreview.blocked_capabilities).toContain('production_allowlist');

    expect(handoff).toMatchObject({
      integration_status: 'sandbox_handoff_requested',
      buyer_agent_discovery_is_public: false,
      agenticorg_public_discovery_enabled: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      production_allowlist_written: false,
      live_mode_status: 'not_live',
      production_approval_status: 'not_approved',
      rollout_status: 'rollout_not_requested',
    });
    expect(handoff.live_plural_enabled).toBe(false);
    expect(handoff.blocked_buyer_agent_capabilities).toContain('direct_merchant_system_access');

    const serialized = JSON.stringify(handoff).toLowerCase();
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('jwt');
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('redis://');
    expect(serialized).not.toContain('merchant-private');
    expect(serialized).not.toContain('allowlist_value');
  });
});
