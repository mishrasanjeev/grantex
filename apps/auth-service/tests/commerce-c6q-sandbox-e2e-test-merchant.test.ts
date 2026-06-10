import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  computeSandboxAgentFacingPreview,
  computeSandboxCatalogReadiness,
  computeSandboxOnboardingReadiness,
  computeSandboxReadOnlyDiscoveryReview,
  toSandboxAgenticOrgBuyerDiscoveryPreviewResponse,
  toSandboxReadOnlyDiscoveryOperatorReviewResponse,
  toSandboxReadOnlyDiscoveryRolloutProposalResponse,
  type SandboxAgentPreviewProductInput,
  type SandboxAgenticOrgBuyerDiscoveryPreviewPayload,
  type SandboxOnboardingCatalogSummary,
  type SandboxOnboardingMerchant,
  type SandboxReadOnlyDiscoveryReviewAuditSnapshot,
} from '../src/lib/commerce/sandbox-onboarding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const fixturePath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'fixtures',
  'c6q-sandbox-e2e',
  'dummyjson-homegoods-products.snapshot.json',
);
const docPath = join(
  repoRoot,
  'docs',
  'internal',
  'commerce-v1',
  'commerce-v1-c6q-sandbox-e2e-test-merchant.md',
);
const reportsDir = join(repoRoot, 'docs', 'internal', 'commerce-v1', 'reports');
const NOW = new Date('2026-06-08T00:00:00.000Z');
const MERCHANT_ID = 'mch_sandbox_dummyjson_homegoods_0001';
const TENANT_ID = 'cten_sandbox_dummyjson_homegoods_0001';

interface DummyJsonProduct {
  id: number;
  title: string;
  description: string;
  category: string;
  brand: string;
  thumbnail: string;
  price: number | null;
  currency: string;
  availabilityStatus: string;
  sku: string;
  warrantyInformation: string;
  returnPolicy: string;
  [key: string]: unknown;
}

interface C6QFixture {
  fixture_version: string;
  fixture_status: string;
  source: {
    source_type: string;
    source_name: string;
    source_url: string;
    snapshot_recorded_at: string;
    credentials_required: boolean;
    outbound_sync_enabled: boolean;
    live_network_required_for_tests: boolean;
  };
  merchant: {
    name: string;
    merchant_id: string;
    tenant_id: string;
    requested_category_preset: string;
    runtime_category_preset: string;
    category_mismatch_reason: string;
    status: Record<string, boolean>;
  };
  products: DummyJsonProduct[];
}

interface DryRunEvidence {
  status: 'passed' | 'blocked';
  source_type: 'public_fake_catalog';
  source_name: 'dummyjson_products';
  connector_key: 'dummyjson_homegoods_fixture';
  metadata_only: false;
  local_fixture_ingest_only: true;
  credentials_required: false;
  outbound_sync_enabled: false;
  provider_call_enabled: false;
  merchant_private_api_call_enabled: false;
  agenticorg_direct_execution_enabled: false;
  rows_seen: number;
  rows_accepted: number;
  blockers: string[];
  audit_events: Array<{ event_type: string; audit_event_id: string }>;
  normalized_products: SandboxAgentPreviewProductInput[];
  catalog_summary: SandboxOnboardingCatalogSummary;
  source_precedence_preview: Array<{
    domain: string;
    primary_connector_key: string | null;
    status: string;
    blockers: string[];
  }>;
}

type BuyerIntent =
  | 'read_only_discovery'
  | 'checkout_payment'
  | 'live_provider'
  | 'fulfillment'
  | 'refund_return'
  | 'unsupported';

interface BuyerSessionResponse {
  status: 'ok' | 'refused' | 'blocked';
  message: string;
  merchant_preview: {
    display_name: string | null;
    category_preset: string | null;
  };
  catalog_samples: Array<{
    title: string;
    variants: Array<{
      sku: string;
      price_amount: number | string;
      currency: string;
      availability_status: string;
    }>;
  }>;
  allowed_capabilities: string[];
  blocked_capabilities: string[];
  source_reference: {
    system: 'grantex';
    surface: 'agenticorg_buyer_discovery_preview';
    merchant_reference: string;
    audit_event_id: string | null;
  };
  refusal_code: string | null;
  evidence_summary: {
    grounded_in_grantex: true;
    integration_status: string;
    preview_status: string;
    dry_run_result: string;
    sample_product_count: number;
  };
}

const FORBIDDEN_SOURCE_FIELDS = [
  'api_key',
  'access_token',
  'refresh_token',
  'password',
  'client_secret',
  'private_key',
  'credential',
  'credentials',
  'raw_payload',
  'provider_metadata',
  'private_note',
];
const SOURCE_CATEGORIES = new Set(['furniture', 'home-decoration', 'lighting']);
const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'pre_order', 'back_order', 'unknown']);
const REFUSAL_CODES: Record<Exclude<BuyerIntent, 'read_only_discovery'>, string> = {
  checkout_payment: 'checkout_payment_refused_sandbox_read_only',
  live_provider: 'live_provider_refused_sandbox_read_only',
  fulfillment: 'fulfillment_refused_sandbox_read_only',
  refund_return: 'refund_return_refused_sandbox_read_only',
  unsupported: 'unsupported_intent_refused_sandbox_read_only',
};

function readFixture(): C6QFixture {
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as C6QFixture;
}

function fixtureMerchant(fixture = readFixture()): SandboxOnboardingMerchant {
  return {
    id: fixture.merchant.merchant_id,
    tenant_id: fixture.merchant.tenant_id,
    display_name: fixture.merchant.name,
    category_preset: fixture.merchant.runtime_category_preset,
    environment: 'sandbox',
    agentic_commerce_enabled: false,
    default_currency: 'USD',
    country_code: 'US',
    support_email: 'support@dummyjson-homegoods.test',
    support_url: 'https://dummyjson-homegoods.test/help',
    public_discovery_description_draft: 'Sandbox catalog profile for fake home goods items.',
    agentic_commerce_requested: true,
    sandbox_onboarding_state: 'submitted_for_review',
    sandbox_onboarding_blocker: null,
    sandbox_onboarding_updated_at: NOW.toISOString(),
    provider_account_refs: {},
  };
}

function hasForbiddenField(product: Record<string, unknown>): boolean {
  return Object.keys(product).some((key) => FORBIDDEN_SOURCE_FIELDS.includes(key.toLowerCase()));
}

function safeImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'cdn.dummyjson.com';
  } catch {
    return false;
  }
}

function staleSnapshot(recordedAt: string, now = NOW): boolean {
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return true;
  return now.getTime() - date.getTime() > 14 * 24 * 60 * 60 * 1000;
}

function productBlockers(product: DummyJsonProduct, recordedAt: string): string[] {
  const blockers: string[] = [];
  if (!SOURCE_CATEGORIES.has(product.category)) blockers.push('unsupported_category');
  if (product.price === null || typeof product.price !== 'number' || product.price < 0) blockers.push('missing_price');
  if (!safeImageUrl(product.thumbnail)) blockers.push('unsafe_image_url');
  if (staleSnapshot(recordedAt)) blockers.push('stale_source_timestamp');
  if (hasForbiddenField(product)) blockers.push('private_field_in_source');
  if (!AVAILABILITY.has(product.availabilityStatus)) blockers.push('unknown_availability_bucket');
  return blockers;
}

function normalizeFixtureProduct(product: DummyJsonProduct): SandboxAgentPreviewProductInput {
  return {
    title: product.title,
    description: product.description,
    image_url: product.thumbnail,
    category_preset: 'electronics_appliances',
    variants: [{
      sku: product.sku,
      variant_title: product.category.replace('-', ' '),
      price_amount: Math.round((product.price ?? 0) * 100),
      currency: product.currency,
      availability_status: product.availabilityStatus,
      warranty_summary: product.warrantyInformation,
      return_policy_summary: product.returnPolicy,
    }],
  };
}

function dryRunFixtureImport(fixture = readFixture()): DryRunEvidence {
  const normalized: SandboxAgentPreviewProductInput[] = [];
  const blockers: string[] = [];
  for (const product of fixture.products) {
    const productBlockerList = productBlockers(product, fixture.source.snapshot_recorded_at);
    for (const blocker of productBlockerList) {
      if (!blockers.includes(blocker)) blockers.push(blocker);
    }
    if (productBlockerList.length === 0) normalized.push(normalizeFixtureProduct(product));
  }

  const productCount = normalized.length;
  const variantCount = normalized.reduce((count, product) => count + (product.variants ?? []).length, 0);
  const catalogSummary: SandboxOnboardingCatalogSummary = {
    product_count: productCount,
    variant_count: variantCount,
    products_with_image: normalized.filter((product) => product.image_url).length,
    products_with_public_safe_title: productCount,
    products_with_public_safe_description: productCount,
    products_with_category_mapping: productCount,
    products_with_unsafe_text: 0,
    variants_with_sku: variantCount,
    variants_with_price_currency: variantCount,
    variants_with_warranty_summary: variantCount,
    variants_with_return_policy_summary: variantCount,
    variants_with_tax_metadata: 0,
    variants_with_fresh_inventory: variantCount,
    variants_with_known_availability: variantCount,
    variants_with_unsafe_text: 0,
  };

  return {
    status: blockers.length === 0 ? 'passed' : 'blocked',
    source_type: 'public_fake_catalog',
    source_name: 'dummyjson_products',
    connector_key: 'dummyjson_homegoods_fixture',
    metadata_only: false,
    local_fixture_ingest_only: true,
    credentials_required: false,
    outbound_sync_enabled: false,
    provider_call_enabled: false,
    merchant_private_api_call_enabled: false,
    agenticorg_direct_execution_enabled: false,
    rows_seen: fixture.products.length,
    rows_accepted: normalized.length,
    blockers,
    audit_events: [
      { event_type: 'merchant.sandbox_fixture.created', audit_event_id: 'caud_c6q_fixture_created' },
      { event_type: 'merchant.connector.catalog_dry_run.preview', audit_event_id: 'caud_c6q_catalog_dry_run' },
      { event_type: 'merchant.agent_facing_preview.generated', audit_event_id: 'caud_c6q_agent_preview' },
    ],
    normalized_products: normalized,
    catalog_summary: catalogSummary,
    source_precedence_preview: [
      { domain: 'catalog', primary_connector_key: 'dummyjson_homegoods_fixture', status: 'preview', blockers: [] },
      { domain: 'price', primary_connector_key: 'dummyjson_homegoods_fixture', status: 'preview', blockers: [] },
      { domain: 'inventory', primary_connector_key: 'dummyjson_homegoods_fixture', status: 'preview', blockers: [] },
      { domain: 'order', primary_connector_key: null, status: 'blocked', blockers: ['execution_domain_metadata_only'] },
      { domain: 'fulfillment', primary_connector_key: null, status: 'blocked', blockers: ['execution_domain_metadata_only'] },
      { domain: 'refund', primary_connector_key: null, status: 'blocked', blockers: ['execution_domain_metadata_only'] },
      { domain: 'settlement', primary_connector_key: null, status: 'blocked', blockers: ['execution_domain_metadata_only'] },
      { domain: 'support', primary_connector_key: null, status: 'blocked', blockers: ['execution_domain_metadata_only'] },
    ],
  };
}

function auditSnapshot(
  auditEventId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): SandboxReadOnlyDiscoveryReviewAuditSnapshot {
  return {
    audit_event_id: auditEventId,
    event_type: eventType,
    occurred_at: NOW.toISOString(),
    actor: 'sandbox_operator_c6q',
    metadata,
  };
}

function buildHandoffPreview() {
  const fixture = readFixture();
  const merchant = fixtureMerchant(fixture);
  const dryRun = dryRunFixtureImport(fixture);
  const readiness = computeSandboxOnboardingReadiness(merchant, {}, dryRun.catalog_summary);
  const requestAudit = auditSnapshot(
    'caud_c6q_review_requested',
    'merchant.sandbox_onboarding.read_only_discovery_review.requested',
    { requested_at: NOW.toISOString(), sandbox_only: true },
  );
  const decisionAudit = auditSnapshot(
    'caud_c6q_operator_decision',
    'merchant.sandbox_onboarding.read_only_discovery_review.rollout_proposal_ready',
    { decision_reason: 'Sandbox fake catalog evidence accepted for proposal draft.', blockers: [] },
  );
  const proposalAudit = auditSnapshot(
    'caud_c6q_rollout_dry_run',
    'merchant.sandbox_onboarding.read_only_discovery_rollout_proposal.dry_run_passed',
    { proposal_note: 'Local sandbox dry run passed with fake catalog fixture.', blockers: [] },
  );
  const handoffAudit = auditSnapshot(
    'caud_c6q_agenticorg_handoff',
    'merchant.sandbox_onboarding.agenticorg_buyer_discovery_handoff.requested',
    { handoff_requested_at: NOW.toISOString(), handoff_request_actor: 'sandbox_operator_c6q' },
  );

  return {
    fixture,
    merchant,
    dryRun,
    readiness,
    requestAudit,
    decisionAudit,
    proposalAudit,
    handoffAudit,
    preview: toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
      merchant,
      readiness,
      dryRun.normalized_products,
      requestAudit,
      decisionAudit,
      proposalAudit,
      handoffAudit,
      NOW,
    ),
  };
}

function classifyBuyerIntent(message: string): BuyerIntent {
  const text = message.toLowerCase();
  if (/\b(checkout|pay|payment|buy|cart)\b/.test(text)) return 'checkout_payment';
  if (/\b(live|provider|plural|stripe|pine|razorpay|cashfree|adyen)\b/.test(text)) return 'live_provider';
  if (/\b(deliver|delivery|ship|shipping|fulfill|fulfillment)\b/.test(text)) return 'fulfillment';
  if (/\b(refund|return|replace|replacement)\b/.test(text)) return 'refund_return';
  if (/\b(discover|show|catalog|products|store|merchant|sofa|shelf|lamp)\b/.test(text)) return 'read_only_discovery';
  return 'unsupported';
}

function buyerSessionResponse(
  preview: SandboxAgenticOrgBuyerDiscoveryPreviewPayload,
  message: string,
): BuyerSessionResponse {
  const intent = classifyBuyerIntent(message);
  const base = {
    merchant_preview: {
      display_name: preview.display_name,
      category_preset: preview.merchant.category_preset,
    },
    catalog_samples: preview.sample_products.map((product) => ({
      title: product.title,
      variants: product.variants.map((variant) => ({
        sku: variant.sku,
        price_amount: variant.price_amount,
        currency: variant.currency,
        availability_status: variant.availability_status,
      })),
    })),
    allowed_capabilities: [...preview.allowed_buyer_agent_capabilities],
    blocked_capabilities: [...preview.blocked_buyer_agent_capabilities],
    source_reference: {
      system: 'grantex' as const,
      surface: 'agenticorg_buyer_discovery_preview' as const,
      merchant_reference: preview.merchant_reference,
      audit_event_id: preview.audit_event_id,
    },
    evidence_summary: {
      grounded_in_grantex: true as const,
      integration_status: preview.integration_status,
      preview_status: preview.agent_facing_preview_summary.preview_status,
      dry_run_result: preview.rollout_proposal_summary.dry_run_result,
      sample_product_count: preview.sample_products.length,
    },
  };

  if (intent !== 'read_only_discovery') {
    return {
      status: 'refused',
      message: 'This sandbox buyer session supports only Grantex-grounded read-only discovery.',
      ...base,
      refusal_code: REFUSAL_CODES[intent],
    };
  }

  if (preview.integration_status !== 'sandbox_handoff_requested'
    || preview.agent_facing_preview_summary.preview_status !== 'ready') {
    return {
      status: 'blocked',
      message: 'Grantex sandbox buyer discovery preview is not available.',
      ...base,
      refusal_code: 'grantex_preview_not_available',
    };
  }

  return {
    status: 'ok',
    message: `Showing Grantex-grounded sandbox catalog samples for ${preview.display_name}.`,
    ...base,
    refusal_code: null,
  };
}

describe('C6Q sandbox E2E test merchant rehearsal', () => {
  it('uses a public fake catalog fixture and sandbox-only test merchant identity', () => {
    const fixture = readFixture();

    expect(fixture.source).toMatchObject({
      source_type: 'public_fake_catalog',
      source_name: 'dummyjson_products',
      source_url: 'https://dummyjson.com/docs/products',
      credentials_required: false,
      outbound_sync_enabled: false,
      live_network_required_for_tests: false,
    });
    expect(fixture.fixture_status).toBe('sandbox_only_not_live_not_public_not_allowlisted_not_approved');
    expect(fixture.merchant).toMatchObject({
      name: 'DummyJSON Home Goods Sandbox Store',
      merchant_id: MERCHANT_ID,
      tenant_id: TENANT_ID,
      requested_category_preset: 'home_furniture',
      runtime_category_preset: 'electronics_appliances',
    });
    expect(fixture.merchant.status).toMatchObject({
      sandbox_only: true,
      not_live: true,
      not_approved: true,
      not_public: true,
      not_allowlisted: true,
    });
    expect(fixture.products).toHaveLength(3);
    expect(JSON.stringify(fixture)).not.toMatch(/GST|PAN|tax_id|phone|address|sk_live_|pk_live_|client_secret|access_token/i);
  });

  it('dry-runs fake catalog import, normalizes products, and records non-enabling evidence', () => {
    const dryRun = dryRunFixtureImport();

    expect(dryRun).toMatchObject({
      status: 'passed',
      source_type: 'public_fake_catalog',
      source_name: 'dummyjson_products',
      connector_key: 'dummyjson_homegoods_fixture',
      metadata_only: false,
      local_fixture_ingest_only: true,
      credentials_required: false,
      outbound_sync_enabled: false,
      provider_call_enabled: false,
      merchant_private_api_call_enabled: false,
      agenticorg_direct_execution_enabled: false,
      rows_seen: 3,
      rows_accepted: 3,
      blockers: [],
    });
    expect(dryRun.normalized_products).toHaveLength(3);
    expect(dryRun.normalized_products[0]).toMatchObject({
      title: 'Modular Sofa Test Fixture',
      category_preset: 'electronics_appliances',
      variants: [{
        sku: 'DJS-HG-SOFA-001',
        price_amount: 12999,
        currency: 'USD',
        availability_status: 'in_stock',
      }],
    });
    expect(dryRun.catalog_summary).toMatchObject({
      product_count: 3,
      variant_count: 3,
      products_with_category_mapping: 3,
      variants_with_price_currency: 3,
      variants_with_fresh_inventory: 3,
      variants_with_known_availability: 3,
      products_with_unsafe_text: 0,
      variants_with_unsafe_text: 0,
    });
    expect(dryRun.audit_events.map((event) => event.event_type)).toEqual([
      'merchant.sandbox_fixture.created',
      'merchant.connector.catalog_dry_run.preview',
      'merchant.agent_facing_preview.generated',
    ]);
    expect(dryRun.source_precedence_preview.find((entry) => entry.domain === 'catalog'))
      .toMatchObject({ primary_connector_key: 'dummyjson_homegoods_fixture', status: 'preview' });
    expect(dryRun.source_precedence_preview.find((entry) => entry.domain === 'fulfillment')?.blockers)
      .toContain('execution_domain_metadata_only');
  });

  it('detects missing category mapping, missing price, unsafe image, stale timestamp, and private source fields', () => {
    const fixture = readFixture();
    const base = fixture.products[0]!;
    const blocked: DummyJsonProduct = {
      ...base,
      category: 'beauty',
      price: null,
      thumbnail: 'https://real-merchant.example.test/private-image.png',
      private_note: 'synthetic negative marker',
    };

    expect(productBlockers(blocked, '2026-05-01T00:00:00.000Z')).toEqual(expect.arrayContaining([
      'unsupported_category',
      'missing_price',
      'unsafe_image_url',
      'stale_source_timestamp',
      'private_field_in_source',
    ]));
  });

  it('runs Grantex sandbox readiness, preview, review, rollout, and AgenticOrg handoff helpers end to end', () => {
    const { merchant, dryRun, readiness, requestAudit, decisionAudit, proposalAudit, handoffAudit, preview } =
      buildHandoffPreview();
    const catalogReadiness = computeSandboxCatalogReadiness(merchant, dryRun.catalog_summary);
    const agentPreview = computeSandboxAgentFacingPreview(merchant, readiness, dryRun.normalized_products, NOW);
    const review = computeSandboxReadOnlyDiscoveryReview(merchant, readiness, agentPreview);
    const operatorReview = toSandboxReadOnlyDiscoveryOperatorReviewResponse(
      merchant,
      readiness,
      dryRun.normalized_products,
      requestAudit,
      decisionAudit,
      NOW,
    );
    const rollout = toSandboxReadOnlyDiscoveryRolloutProposalResponse(
      merchant,
      readiness,
      dryRun.normalized_products,
      requestAudit,
      decisionAudit,
      proposalAudit,
      NOW,
    );

    expect(catalogReadiness.status).toBe('pass');
    expect(readiness).toMatchObject({
      ready: true,
      status: 'pass',
      live_mode_status: 'not_live',
      production_approval_status: 'not_approved',
      rollout_status: 'rollout_not_requested',
    });
    expect(agentPreview).toMatchObject({
      preview_status: 'ready',
      sandbox_only: true,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
    });
    expect(agentPreview.sample_products).toHaveLength(3);
    expect(review).toMatchObject({
      status: 'requested',
      eligible: true,
      request_is_approval: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      production_allowlist_written: false,
    });
    expect(operatorReview).toMatchObject({
      operator_decision: 'rollout_proposal_ready',
      operator_decision_is_approval: false,
      rollout_proposal_ready_is_launch: false,
      blockers: [],
    });
    expect(rollout).toMatchObject({
      proposal_status: 'dry_run_passed',
      dry_run_result: 'passed',
      proposal_is_approval: false,
      dry_run_is_launch: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
      blockers: [],
    });
    expect(preview).toMatchObject({
      merchant_id: MERCHANT_ID,
      tenant_id: TENANT_ID,
      display_name: 'DummyJSON Home Goods Sandbox Store',
      integration_status: 'sandbox_handoff_requested',
      audit_event_id: handoffAudit.audit_event_id,
      sandbox_only: true,
      handoff_request_is_approval: false,
      buyer_agent_discovery_is_public: false,
      agenticorg_public_discovery_enabled: false,
      public_discovery_enabled: false,
      checkout_payment_enabled: false,
      live_provider_enabled: false,
      live_plural_enabled: false,
      production_allowlist_written: false,
      live_mode_status: 'not_live',
      production_approval_status: 'not_approved',
    });
    expect(preview.sample_products.map((product) => product.title)).toEqual([
      'Modular Sofa Test Fixture',
      'Oak Shelf Test Fixture',
      'Table Lamp Test Fixture',
    ]);
    expect(preview.blocked_buyer_agent_capabilities).toEqual(expect.arrayContaining([
      'checkout_payment_creation',
      'live_payment',
      'live_plural',
      'order_fulfillment',
      'refunds_returns_execution',
      'direct_merchant_system_access',
    ]));
    expect(preview.rollout_proposal_summary).toMatchObject({
      proposal_status: 'dry_run_passed',
      dry_run_result: 'passed',
      operator_decision: 'rollout_proposal_ready',
    });
  });

  it('blocks rollout and AgenticOrg handoff when prerequisites are absent', () => {
    const fixture = readFixture();
    const merchant = fixtureMerchant(fixture);
    const dryRun = dryRunFixtureImport(fixture);
    const readiness = computeSandboxOnboardingReadiness(merchant, {}, dryRun.catalog_summary);
    const previewWithoutAudits = toSandboxAgenticOrgBuyerDiscoveryPreviewResponse(
      merchant,
      readiness,
      dryRun.normalized_products,
      null,
      null,
      null,
      null,
      NOW,
    );

    expect(previewWithoutAudits.integration_status).toBe('not_ready');
    expect(previewWithoutAudits.blockers).toContain('rollout_proposal_not_created');
    expect(previewWithoutAudits.blockers).toContain('operator_review_rollout_proposal_ready_missing');
    expect(previewWithoutAudits.public_discovery_enabled).toBe(false);
    expect(previewWithoutAudits.checkout_payment_enabled).toBe(false);
    expect(previewWithoutAudits.live_provider_enabled).toBe(false);
    expect(previewWithoutAudits.production_allowlist_written).toBe(false);
  });

  it('simulates AgenticOrg buyer discovery as a grounded read-only response', () => {
    const { preview } = buildHandoffPreview();
    const injectedPreview = {
      ...preview,
      private_token: 'synthetic negative marker',
      raw_payload: { ignored: true },
      provider_metadata: { ignored: true },
    } as SandboxAgenticOrgBuyerDiscoveryPreviewPayload & Record<string, unknown>;

    const response = buyerSessionResponse(injectedPreview, 'Show me catalog samples from this store');

    expect(response).toMatchObject({
      status: 'ok',
      refusal_code: null,
      merchant_preview: {
        display_name: 'DummyJSON Home Goods Sandbox Store',
        category_preset: 'electronics_appliances',
      },
      source_reference: {
        system: 'grantex',
        surface: 'agenticorg_buyer_discovery_preview',
        merchant_reference: MERCHANT_ID,
        audit_event_id: 'caud_c6q_agenticorg_handoff',
      },
      evidence_summary: {
        grounded_in_grantex: true,
        integration_status: 'sandbox_handoff_requested',
        preview_status: 'ready',
        dry_run_result: 'passed',
        sample_product_count: 3,
      },
    });
    expect(response.catalog_samples).toHaveLength(3);
    expect(response.allowed_capabilities).toEqual([
      'read_only_profile_discovery_preview',
      'read_only_catalog_discovery_preview',
      'buyer_agent_readiness_context',
    ]);
    expect(response.blocked_capabilities).toEqual(expect.arrayContaining([
      'checkout_payment_creation',
      'live_payment',
      'live_plural',
      'order_fulfillment',
      'refunds_returns_execution',
      'direct_merchant_system_access',
    ]));
    const responseJson = JSON.stringify(response);
    expect(responseJson).not.toContain('private_token');
    expect(responseJson).not.toContain('raw_payload');
    expect(responseJson).not.toContain('provider_metadata');
    expect(responseJson).not.toMatch(/delivery by|guaranteed stock|payment link|checkout url|refund processed/i);
  });

  it('refuses checkout, payment, live provider, live Plural, fulfillment, and refund intents', () => {
    const { preview } = buildHandoffPreview();
    const cases: Array<[string, string]> = [
      ['Create checkout for the sofa', 'checkout_payment_refused_sandbox_read_only'],
      ['I want to pay now', 'checkout_payment_refused_sandbox_read_only'],
      ['Use live Plural for this catalog', 'live_provider_refused_sandbox_read_only'],
      ['Ship this item tomorrow', 'fulfillment_refused_sandbox_read_only'],
      ['Process a refund for my order', 'refund_return_refused_sandbox_read_only'],
    ];

    for (const [message, refusalCode] of cases) {
      const response = buyerSessionResponse(preview, message);
      expect(response.status).toBe('refused');
      expect(response.refusal_code).toBe(refusalCode);
      expect(response.message).toContain('Grantex-grounded read-only discovery');
      expect(response.evidence_summary.grounded_in_grantex).toBe(true);
      expect(response.source_reference.system).toBe('grantex');
      expect(response.blocked_capabilities).toContain('checkout_payment_creation');
      expect(response.blocked_capabilities).toContain('direct_merchant_system_access');
    }
  });

  it('keeps C6Q docs and fixtures internal, fake, non-public, and non-certifying', () => {
    const doc = readFileSync(docPath, 'utf8');
    const fixture = readFileSync(fixturePath, 'utf8');

    expect(doc).toContain('C6Q creates a deterministic sandbox E2E rehearsal');
    expect(doc).toContain('C6Q uses a checked-in fixture snapshot');
    expect(doc).toContain('home_furniture is not implemented');
    expect(doc).toContain('AgenticOrg never directly calls merchant private APIs');
    expect(doc).toContain('Do not approve production launch');
    expect(doc).toContain('Stop and require a new approved work item');
    expect(fixture).toContain('"not_public": true');
    expect(fixture).toContain('"not_allowlisted": true');
    expect(fixture).toContain('"not_approved": true');
    expect(existsSync(reportsDir)).toBe(false);
    expect(`${doc}\n${fixture}`).not.toMatch(/certified|certification approved|production approved|public protocol publication approved|live payment approved/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_ENABLED\s*=\s*true/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST\s*=\s*[^<\s]/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/public_discovery_enabled\s*[:=]\s*true/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/checkout_payment_enabled\s*[:=]\s*true/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/live_[A-Za-z0-9_]*\s*[:=]\s*true/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/provider_call_enabled\s*[:=]\s*true/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/merchant_private_api_call_enabled\s*[:=]\s*true/i);
    expect(`${doc}\n${fixture}`).not.toMatch(/agenticorg_direct_execution_enabled\s*[:=]\s*true/i);
  });
});
