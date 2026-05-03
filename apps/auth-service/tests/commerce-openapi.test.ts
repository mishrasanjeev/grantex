import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const yamlPath = join(__dirname, '..', '..', '..', 'docs', 'api', 'grantex-commerce-v1.openapi.yaml');

describe('Grantex Commerce V1 OpenAPI 3.1 contract', () => {
  it('docs/api/grantex-commerce-v1.openapi.yaml exists', () => {
    expect(() => readFileSync(yamlPath, 'utf8')).not.toThrow();
  });

  it('declares openapi: 3.1.x and is non-empty', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toMatch(/openapi:\s*"?3\.1/);
    expect(content.length).toBeGreaterThan(1000);
  });

  it('declares the standard error envelope shape (error.code, error.message)', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toMatch(/Error:\s*\n\s+type:\s+object/);
    expect(content).toMatch(/code:\s*\{\s*type:\s*string/);
    expect(content).toMatch(/decision_id:/);
    expect(content).toMatch(/audit_event_id:/);
    expect(content).toMatch(/retryable:/);
  });

  it('lists every M1-implemented path with x-implemented: true', () => {
    const content = readFileSync(yamlPath, 'utf8');
    const expected = [
      '/v1/commerce/merchants',
      '/v1/commerce/merchants/{merchant_id}',
      '/v1/commerce/agents',
      '/v1/commerce/agents/{agent_id}',
      '/v1/commerce/catalog/products',
      '/v1/commerce/catalog/products/{product_id}',
      '/v1/commerce/audit/events',
    ];
    for (const path of expected) {
      expect(content, `OpenAPI must include ${path}`).toContain(path);
    }
    // At least one explicit x-implemented: true marker per implemented op
    const trueCount = (content.match(/x-implemented:\s*true/g) ?? []).length;
    expect(trueCount).toBeGreaterThanOrEqual(expected.length);
  });

  it('declares stub paths for M2-M5 surface (passports, payments, MCP, providers)', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/v1/commerce/passports/consent-requests');
    expect(content).toContain('/v1/commerce/payments/intents');
    expect(content).toContain('/v1/commerce/provider-credentials');
    expect(content).toContain('/v1/webhooks/providers/{provider_key}');
    expect(content).toContain('/.well-known/grantex-commerce');
    expect(content).toContain('/mcp');
  });

  it('declares M2 explicit tenant provisioning stubs (paired with the 422 tenant_not_provisioned posture)', () => {
    const content = readFileSync(yamlPath, 'utf8');
    expect(content).toContain('/v1/commerce/tenants');
    expect(content).toContain('/v1/commerce/developer-tenants');
    expect(content).toMatch(/x-milestone:\s*M2/);
  });
});
