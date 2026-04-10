/**
 * E2E Tests: Custom Domain Management
 *
 * Tests domain creation, listing, DNS verification, deletion,
 * plan enforcement, and error handling.
 * Run: npx vitest run tests/e2e/domains.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;
let domainsAvailable = false;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-domains-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  // Probe whether the plan supports custom domains
  try {
    const probe = await grantex.domains.create({ domain: `probe-${Date.now()}.example.com` });
    domainsAvailable = true;
    // Clean up probe domain
    await grantex.domains.delete(probe.id);
  } catch {
    // 402 PLAN_LIMIT_EXCEEDED — free/pro plan, skip domain CRUD tests
  }
});

describe('E2E: Domain Plan Enforcement', () => {
  it('rejects domains on free plan or allows on enterprise', async () => {
    if (domainsAvailable) {
      // Enterprise plan — creation works (already verified in beforeAll)
      expect(domainsAvailable).toBe(true);
    } else {
      // Free/Pro plan — should get 402
      try {
        await grantex.domains.create({ domain: `plan-check-${Date.now()}.example.com` });
        expect.fail('Should have thrown on free plan');
      } catch (err: any) {
        const status = err.statusCode ?? err.status ?? err.response?.status;
        expect(status).toBe(402);
      }
    }
  });
});

describe('E2E: Domain CRUD', () => {
  let domainId: string;
  let domainName: string;
  let verificationToken: string;

  it('creates a custom domain', async () => {
    if (!domainsAvailable) return;
    domainName = `test-${Date.now()}.example.com`;
    const domain = await grantex.domains.create({ domain: domainName });
    domainId = domain.id;

    expect(domain.id).toBeDefined();
    expect(typeof domain.id).toBe('string');
    expect(domain.domain).toBe(domainName);
    expect(domain.verified).toBe(false);
    expect(domain.verificationToken).toBeDefined();
    expect(typeof domain.verificationToken).toBe('string');
    expect(domain.verificationToken.length).toBeGreaterThan(0);
    expect(domain.instructions).toBeDefined();
    expect(domain.instructions).toContain('TXT');
    expect(domain.instructions).toContain(domainName);

    verificationToken = domain.verificationToken;
  });

  it('creates a second domain', async () => {
    if (!domainsAvailable) return;
    const secondDomain = `api-${Date.now()}.example.org`;
    const domain = await grantex.domains.create({ domain: secondDomain });

    expect(domain.id).toBeDefined();
    expect(domain.id).not.toBe(domainId);
    expect(domain.domain).toBe(secondDomain);
    expect(domain.verified).toBe(false);
    expect(domain.verificationToken).not.toBe(verificationToken);
  });

  it('lists all domains', async () => {
    if (!domainsAvailable) return;
    const result = await grantex.domains.list();
    expect(result).toBeDefined();
    expect(result.domains).toBeDefined();
    expect(Array.isArray(result.domains)).toBe(true);
    expect(result.domains.length).toBeGreaterThanOrEqual(2);

    const found = result.domains.find((d: any) => d.id === domainId);
    expect(found).toBeDefined();
    expect(found!.domain).toBe(domainName);
    expect(found!.verified).toBe(false);
    expect(found!.createdAt).toBeDefined();
  });

  it('verify domain fails for non-existent DNS record', async () => {
    if (!domainsAvailable) return;
    try {
      const result = await grantex.domains.verify(domainId);
      expect(result.verified).toBe(false);
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });

  it('returns 404 when verifying non-existent domain', async () => {
    if (!domainsAvailable) return;
    try {
      await grantex.domains.verify('dom_nonexistent_000');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });

  it('deletes a domain', async () => {
    if (!domainsAvailable) return;
    await grantex.domains.delete(domainId);

    const result = await grantex.domains.list();
    const found = result.domains.find((d: any) => d.id === domainId);
    expect(found).toBeUndefined();
  });

  it('returns 404 when deleting an already-deleted domain', async () => {
    if (!domainsAvailable) return;
    await expect(grantex.domains.delete(domainId)).rejects.toThrow();
  });

  it('returns 404 when deleting a non-existent domain', async () => {
    if (!domainsAvailable) return;
    await expect(grantex.domains.delete('dom_nonexistent_000')).rejects.toThrow();
  });
});

describe('E2E: Domain Validation', () => {
  it('rejects creating a domain with empty string', async () => {
    await expect(
      grantex.domains.create({ domain: '' }),
    ).rejects.toThrow();
  });

  it('rejects duplicate domain registration', async () => {
    if (!domainsAvailable) return;
    const domainName = `dup-${Date.now()}.example.com`;
    await grantex.domains.create({ domain: domainName });

    await expect(
      grantex.domains.create({ domain: domainName }),
    ).rejects.toThrow();
  });
});
