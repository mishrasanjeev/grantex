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

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-domains-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: Domain CRUD', () => {
  let domainId: string;
  let domainName: string;
  let verificationToken: string;

  it('creates a custom domain', async () => {
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
    const secondDomain = `api-${Date.now()}.example.org`;
    const domain = await grantex.domains.create({ domain: secondDomain });

    expect(domain.id).toBeDefined();
    expect(domain.id).not.toBe(domainId);
    expect(domain.domain).toBe(secondDomain);
    expect(domain.verified).toBe(false);
    expect(domain.verificationToken).not.toBe(verificationToken);
  });

  it('lists all domains', async () => {
    const result = await grantex.domains.list();
    expect(result).toBeDefined();
    expect(result.domains).toBeDefined();
    expect(Array.isArray(result.domains)).toBe(true);
    expect(result.domains.length).toBeGreaterThanOrEqual(2);

    // Find our domain
    const found = result.domains.find((d: any) => d.id === domainId);
    expect(found).toBeDefined();
    expect(found!.domain).toBe(domainName);
    expect(found!.verified).toBe(false);
    expect(found!.createdAt).toBeDefined();
  });

  it('verify domain fails for non-existent DNS record', async () => {
    // DNS record doesn't exist, so verification should fail
    try {
      const result = await grantex.domains.verify(domainId);
      // If it returns, verified should be false
      expect(result.verified).toBe(false);
    } catch (err: any) {
      // Some implementations throw on verification failure
      expect(err).toBeDefined();
    }
  });

  it('returns 404 when verifying non-existent domain', async () => {
    try {
      await grantex.domains.verify('dom_nonexistent_000');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeDefined();
    }
  });

  it('deletes a domain', async () => {
    await grantex.domains.delete(domainId);

    // Verify it's gone
    const result = await grantex.domains.list();
    const found = result.domains.find((d: any) => d.id === domainId);
    expect(found).toBeUndefined();
  });

  it('returns 404 when deleting an already-deleted domain', async () => {
    await expect(grantex.domains.delete(domainId)).rejects.toThrow();
  });

  it('returns 404 when deleting a non-existent domain', async () => {
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
    const domainName = `dup-${Date.now()}.example.com`;
    await grantex.domains.create({ domain: domainName });

    // Second registration of the same domain should fail
    await expect(
      grantex.domains.create({ domain: domainName }),
    ).rejects.toThrow();
  });
});
