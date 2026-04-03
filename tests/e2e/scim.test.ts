/**
 * E2E Tests: SCIM Token Management
 *
 * Tests SCIM token creation, listing, deletion, token secrecy,
 * and SCIM v2 ServiceProviderConfig endpoint.
 * Run: npx vitest run tests/e2e/scim.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-scim-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: SCIM Token Management', () => {
  let tokenId: string;
  let rawToken: string;
  let secondTokenId: string;

  it('creates a SCIM token', async () => {
    const token = await grantex.scim.createToken({ label: 'e2e-test-token' });
    tokenId = token.id;
    rawToken = token.token;

    expect(token.id).toBeDefined();
    expect(typeof token.id).toBe('string');
    expect(token.label).toBe('e2e-test-token');
    expect(token.token).toBeDefined();
    expect(typeof token.token).toBe('string');
    expect(token.token.length).toBeGreaterThan(0);
    expect(token.createdAt).toBeDefined();
  });

  it('creates a second SCIM token with different label', async () => {
    const token = await grantex.scim.createToken({ label: 'e2e-second-token' });
    secondTokenId = token.id;

    expect(token.id).toBeDefined();
    expect(token.id).not.toBe(tokenId);
    expect(token.label).toBe('e2e-second-token');
    expect(token.token).toBeDefined();
    // Each token should be unique
    expect(token.token).not.toBe(rawToken);
  });

  it('lists SCIM tokens', async () => {
    const result = await grantex.scim.listTokens();

    expect(result).toBeDefined();
    expect(result.tokens).toBeDefined();
    expect(Array.isArray(result.tokens)).toBe(true);
    expect(result.tokens.length).toBeGreaterThanOrEqual(2);

    // First token should be in the list
    const found = result.tokens.find((t: any) => t.id === tokenId);
    expect(found).toBeDefined();
    expect(found!.label).toBe('e2e-test-token');
    expect(found!.createdAt).toBeDefined();

    // Raw token should NOT be in the list response
    expect((found as any).token).toBeUndefined();
  });

  it('token IDs are present in list', async () => {
    const result = await grantex.scim.listTokens();
    const ids = result.tokens.map((t: any) => t.id);
    expect(ids).toContain(tokenId);
    expect(ids).toContain(secondTokenId);
  });

  it('revokes a SCIM token', async () => {
    await grantex.scim.revokeToken(tokenId);

    // Verify it's gone
    const result = await grantex.scim.listTokens();
    const found = result.tokens.find((t: any) => t.id === tokenId);
    expect(found).toBeUndefined();

    // Second token should still exist
    const second = result.tokens.find((t: any) => t.id === secondTokenId);
    expect(second).toBeDefined();
  });

  it('returns 404 when revoking an already-deleted token', async () => {
    await expect(grantex.scim.revokeToken(tokenId)).rejects.toThrow();
  });

  it('returns 404 for non-existent token ID', async () => {
    await expect(grantex.scim.revokeToken('scim_nonexistent_000')).rejects.toThrow();
  });

  it('revokes the second token', async () => {
    await grantex.scim.revokeToken(secondTokenId);
    const result = await grantex.scim.listTokens();
    expect(result.tokens.length).toBe(0);
  });
});

describe('E2E: SCIM Token Validation', () => {
  it('rejects token creation without label', async () => {
    await expect(
      grantex.scim.createToken({ label: '' }),
    ).rejects.toThrow();
  });
});

describe('E2E: SCIM ServiceProviderConfig', () => {
  it('returns ServiceProviderConfig (public endpoint)', async () => {
    const res = await fetch(`${BASE_URL}/scim/v2/ServiceProviderConfig`);
    expect(res.ok).toBe(true);

    const config = (await res.json()) as any;
    expect(config.schemas).toBeDefined();
    expect(Array.isArray(config.schemas)).toBe(true);
    expect(config.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig');

    expect(config.patch).toBeDefined();
    expect(config.patch.supported).toBe(true);

    expect(config.bulk).toBeDefined();
    expect(config.bulk.supported).toBe(false);

    expect(config.authenticationSchemes).toBeDefined();
    expect(Array.isArray(config.authenticationSchemes)).toBe(true);
    expect(config.authenticationSchemes.length).toBeGreaterThan(0);
    expect(config.authenticationSchemes[0].type).toBe('oauthbearertoken');
  });
});

describe('E2E: SCIM Users (with SCIM token auth)', () => {
  let scimToken: string;

  beforeAll(async () => {
    const result = await grantex.scim.createToken({ label: 'e2e-scim-users' });
    scimToken = result.token;
  });

  it('lists users (initially empty)', async () => {
    const res = await fetch(`${BASE_URL}/scim/v2/Users`, {
      headers: { Authorization: `Bearer ${scimToken}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;
    expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
    expect(body.totalResults).toBe(0);
    expect(body.Resources).toBeDefined();
    expect(Array.isArray(body.Resources)).toBe(true);
  });

  it('provisions a SCIM user', async () => {
    const res = await fetch(`${BASE_URL}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${scimToken}` },
      body: JSON.stringify({
        userName: 'john.doe@example.com',
        displayName: 'John Doe',
        emails: [{ value: 'john.doe@example.com', primary: true }],
      }),
    });
    expect(res.status).toBe(201);
    const user = (await res.json()) as any;
    expect(user.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
    expect(user.userName).toBe('john.doe@example.com');
    expect(user.displayName).toBe('John Doe');
    expect(user.active).toBe(true);
    expect(user.id).toBeDefined();
  });

  it('rejects SCIM requests without bearer token', async () => {
    const res = await fetch(`${BASE_URL}/scim/v2/Users`);
    expect(res.status).toBe(401);
  });
});
