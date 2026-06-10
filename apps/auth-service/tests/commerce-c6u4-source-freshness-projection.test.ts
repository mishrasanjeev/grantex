import { describe, expect, it } from 'vitest';
import {
  computeSandboxAgentFacingPreview,
  computeSandboxCatalogReadiness,
  computeSandboxOnboardingReadiness,
  type SandboxOnboardingCatalogSummary,
  type SandboxOnboardingMerchant,
} from '../src/lib/commerce/sandbox-onboarding.js';

const now = new Date('2026-06-09T00:00:00.000Z');

function merchant(overrides: Partial<SandboxOnboardingMerchant> = {}): SandboxOnboardingMerchant {
  return {
    id: 'merchant_synthetic_c6u4',
    tenant_id: 'tenant_synthetic_c6u4',
    display_name: 'Synthetic Home Appliance Merchant',
    category_preset: 'electronics_appliances',
    environment: 'sandbox',
    agentic_commerce_enabled: false,
    default_currency: 'INR',
    country_code: 'IN',
    support_email: 'support@example.test',
    support_url: null,
    public_discovery_description_draft: 'Synthetic sandbox appliance catalog for internal buyer-agent review.',
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

describe('C6U4 source/freshness and buyer-safe fact projection contracts', () => {
  it('keeps source freshness, tax, warranty, and return gaps visible in readiness checks', () => {
    const readiness = computeSandboxCatalogReadiness(
      merchant(),
      readyCatalogSummary({
        variants_with_fresh_inventory: 0,
        variants_with_known_availability: 0,
        variants_with_tax_metadata: 0,
        variants_with_warranty_summary: 0,
        variants_with_return_policy_summary: 0,
      }),
    );

    expect(readiness.required_passed).toBe(true);
    expect(readiness.items.find((item) => item.key === 'variants_availability_freshness'))
      .toMatchObject({ status: 'fail', count: 0, total: 1 });
    expect(readiness.items.find((item) => item.key === 'variants_tax_gst_metadata'))
      .toMatchObject({ status: 'fail', count: 0, total: 1 });
    expect(readiness.items.find((item) => item.key === 'variants_warranty_summary'))
      .toMatchObject({ status: 'fail', count: 0, total: 1 });
    expect(readiness.items.find((item) => item.key === 'variants_return_policy_summary'))
      .toMatchObject({ status: 'fail', count: 0, total: 1 });
  });

  it('projects only public-safe preview facts and omits private source or final commercial claims', () => {
    const readiness = computeSandboxOnboardingReadiness(merchant(), {}, readyCatalogSummary());
    const preview = computeSandboxAgentFacingPreview(
      merchant(),
      readiness,
      [{
        title: 'Synthetic Mixer',
        description: 'Synthetic appliance preview item.',
        image_url: 'https://example.test/images/mixer.png',
        category_preset: 'electronics_appliances',
        variants: [{
          sku: 'SKU-C6U4-MIXER',
          variant_title: 'Warm finish',
          price_amount: 1299,
          currency: 'INR',
          availability_status: 'in_stock',
          warranty_summary: 'Synthetic one-year limited warranty summary.',
          return_policy_summary: 'Synthetic seven-day unopened return summary.',
          source_system: 'merchant-private-pim',
          last_synced_at: '2026-06-09T00:00:00.000Z',
          tax_rate: '0.18',
          final_price_amount: 1533,
          delivery_promise: 'tomorrow',
          quantity_available: 25,
        } as unknown as never],
      }],
      now,
    );

    expect(preview.preview_status).toBe('ready');
    expect(preview.public_discovery_enabled).toBe(false);
    expect(preview.checkout_payment_enabled).toBe(false);
    expect(preview.live_provider_enabled).toBe(false);
    expect(preview.sample_products[0]!.variants[0]).toMatchObject({
      sku: 'SKU-C6U4-MIXER',
      price_amount: 1299,
      currency: 'INR',
      availability_status: 'in_stock',
      warranty_summary: 'Synthetic one-year limited warranty summary.',
      return_policy_summary: 'Synthetic seven-day unopened return summary.',
    });

    const serialized = JSON.stringify(preview).toLowerCase();
    expect(serialized).not.toContain('merchant-private-pim');
    expect(serialized).not.toContain('last_synced_at');
    expect(serialized).not.toContain('tax_rate');
    expect(serialized).not.toContain('final_price');
    expect(serialized).not.toContain('delivery_promise');
    expect(serialized).not.toContain('quantity_available');
  });

  it('keeps unknown availability explicit instead of converting it into an in-stock promise', () => {
    const readiness = computeSandboxOnboardingReadiness(merchant(), {}, readyCatalogSummary({
      variants_with_fresh_inventory: 0,
      variants_with_known_availability: 0,
    }));
    const preview = computeSandboxAgentFacingPreview(
      merchant(),
      readiness,
      [{
        title: 'Synthetic Lamp',
        description: 'Synthetic appliance preview item with unknown availability.',
        category_preset: 'electronics_appliances',
        variants: [{
          sku: 'SKU-C6U4-LAMP',
          price_amount: 799,
          currency: 'INR',
          availability_status: 'unknown',
        }],
      }],
      now,
    );

    expect(preview.sample_products[0]!.variants[0]!.availability_status).toBe('unknown');
    expect(JSON.stringify(preview).toLowerCase()).not.toContain('guaranteed in stock');
  });
});
