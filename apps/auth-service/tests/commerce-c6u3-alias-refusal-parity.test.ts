import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { V1_COMMERCE_REQUIRED_SCOPES, V1_COMMERCE_TOOLS } from '../src/lib/commerce/catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', '..');
const mcpRoutePath = join(repoRoot, 'apps', 'auth-service', 'src', 'routes', 'commerce-mcp.ts');
const openApiPath = join(repoRoot, 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');
const fixtureDir = join(repoRoot, 'docs', 'internal', 'commerce-v1', 'fixtures', 'c6oa-preview-conformance');

const expectedTools = [
  'merchant.get_profile',
  'catalog.search',
  'catalog.get_item',
  'inventory.check',
  'cart.create',
  'checkout.create',
  'payment.create_intent',
  'payment.get_status',
] as const;

const nonEnablingFlagKeys = [
  'public_discovery_enabled',
  'commerce_public_discovery_enabled',
  'agenticorg_public_discovery_enabled',
  'production_commerce_v1_enabled',
  'checkout_payment_enabled',
  'checkout_payment_creation_enabled',
  'production_checkout_payment_creation_enabled',
  'checkout_link_creation_enabled',
  'public_checkout_enabled',
  'live_payment_enabled',
  'live_provider_enabled',
  'provider_call_enabled',
  'merchant_private_api_call_enabled',
  'merchant_private_api_calls_enabled',
  'merchant_private_api_calls_from_agenticorg_enabled',
  'provider_credentials_exposed',
  'provider_credentials_included',
  'secrets_included',
  'production_allowlist_written',
  'production_allowlists_written',
] as const;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function collectValuesByKey(value: unknown, key: string, result: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) collectValuesByKey(item, key, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (nestedKey === key) result.push(nestedValue);
    collectValuesByKey(nestedValue, key, result);
  }
  return result;
}

function fixturePaths(): string[] {
  return readdirSync(fixtureDir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(fixtureDir, entry));
}

describe('C6U3 Grantex alias and refusal parity source contracts', () => {
  it('keeps the Commerce V1 MCP tool inventory stable for AgenticOrg aliases', () => {
    expect(V1_COMMERCE_TOOLS).toEqual(expectedTools);
    expect(V1_COMMERCE_REQUIRED_SCOPES).toEqual({
      browse: ['commerce:catalog.read', 'commerce:inventory.read'],
      checkout: ['commerce:checkout.create', 'commerce:payment.initiate', 'commerce:payment.status.read'],
    });

    const route = readFileSync(mcpRoutePath, 'utf8');
    for (const tool of expectedTools) {
      expect(route).toContain(`'${tool}'`);
    }
    expect(route).not.toContain('merchant.private');
    expect(route).not.toContain('merchant_private_api.');
    expect(route).not.toContain('provider.call');
  });

  it('pins payment.get_status to Grantex passport status-read scope for agent callers', () => {
    const route = readFileSync(mcpRoutePath, 'utf8');
    const start = route.indexOf('async function handlePaymentStatus');
    const end = route.indexOf('async function callTool');
    const paymentStatusHandler = route.slice(start, end);

    expect(paymentStatusHandler).toContain("token: args['passport_jwt']");
    expect(paymentStatusHandler).toContain("scope: 'commerce:payment.status.read'");
    expect(paymentStatusHandler).toContain("mode: 'read_only'");
    expect(paymentStatusHandler).toContain("caller.kind === 'agent'");
  });

  it('documents the same MCP inventory in OpenAPI without public discovery or live enablement', () => {
    const openApi = readFileSync(openApiPath, 'utf8');
    for (const tool of expectedTools) {
      expect(openApi).toContain(`- ${tool}`);
    }
    for (const flag of [
      'public_discovery_enabled: { type: boolean, const: false }',
      'checkout_payment_enabled: { type: boolean, const: false }',
      'live_provider_enabled: { type: boolean, const: false }',
      'merchant_private_api_calls_enabled: { type: boolean, const: false }',
    ]) {
      expect(openApi).toContain(flag);
    }
  });

  it('keeps C6O preview fixtures non-enabling for AgenticOrg consumption', () => {
    for (const path of fixturePaths()) {
      const fixture = readJson(path);
      for (const key of nonEnablingFlagKeys) {
        const values = collectValuesByKey(fixture, key);
        for (const value of values) {
          expect(value, `${path} ${key}`).toBe(false);
        }
      }

      for (const value of collectValuesByKey(fixture, 'certification_claims')) {
        expect(value, `${path} certification_claims`).toEqual([]);
      }
      for (const value of collectValuesByKey(fixture, 'production_approval_status')) {
        expect(value, `${path} production_approval_status`).not.toBe('approved');
      }
      for (const value of collectValuesByKey(fixture, 'live_mode_status')) {
        expect(value, `${path} live_mode_status`).not.toBe('live');
      }
    }
  });
});
