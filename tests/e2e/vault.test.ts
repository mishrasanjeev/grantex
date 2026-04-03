/**
 * E2E Tests: Vault Credential Storage
 *
 * Tests store, list, get, delete vault credentials, filtering,
 * upsert behavior, and error handling.
 * Run: npx vitest run tests/e2e/vault.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-vault-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: Vault CRUD', () => {
  let credId: string;
  const principalId = `vault-principal-${Date.now()}`;

  it('stores a credential in the vault', async () => {
    const cred = await grantex.vault.store({
      principalId,
      service: 'github',
      accessToken: 'ghp_test123456789',
      refreshToken: 'ghr_refresh_token',
      credentialType: 'oauth2',
      metadata: { org: 'grantex-dev' },
    });
    credId = cred.id;

    expect(cred.id).toBeDefined();
    expect(typeof cred.id).toBe('string');
    expect(cred.principalId).toBe(principalId);
    expect(cred.service).toBe('github');
    expect(cred.credentialType).toBe('oauth2');
    expect(cred.createdAt).toBeDefined();
  });

  it('stores a second credential for a different service', async () => {
    const cred = await grantex.vault.store({
      principalId,
      service: 'google',
      accessToken: 'ya29.access_token_google',
      credentialType: 'oauth2',
      tokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    expect(cred.id).toBeDefined();
    expect(cred.service).toBe('google');
  });

  it('stores a credential for a different principal', async () => {
    const otherPrincipal = `vault-other-${Date.now()}`;
    const cred = await grantex.vault.store({
      principalId: otherPrincipal,
      service: 'slack',
      accessToken: 'xoxb-slack-token',
      credentialType: 'api_key',
    });

    expect(cred.principalId).toBe(otherPrincipal);
    expect(cred.service).toBe('slack');
  });

  it('lists all vault credentials', async () => {
    const result = await grantex.vault.list();
    expect(result).toBeDefined();
    expect(result.credentials).toBeDefined();
    expect(Array.isArray(result.credentials)).toBe(true);
    expect(result.credentials.length).toBeGreaterThanOrEqual(3);

    // Verify credential shape (metadata only, no raw tokens)
    const cred = result.credentials[0];
    expect(cred).toHaveProperty('id');
    expect(cred).toHaveProperty('principalId');
    expect(cred).toHaveProperty('service');
    expect(cred).toHaveProperty('credentialType');
    expect(cred).toHaveProperty('createdAt');
    // Raw tokens should NOT be in the list response
    expect((cred as any).accessToken).toBeUndefined();
  });

  it('lists credentials filtered by principalId', async () => {
    const res = await fetch(`${BASE_URL}/v1/vault/credentials?principalId=${principalId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { credentials: any[] };
    expect(body.credentials.length).toBe(2); // github + google
    body.credentials.forEach((c: any) => {
      expect(c.principalId).toBe(principalId);
    });
  });

  it('lists credentials filtered by service', async () => {
    const res = await fetch(`${BASE_URL}/v1/vault/credentials?service=github`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { credentials: any[] };
    expect(body.credentials.length).toBeGreaterThanOrEqual(1);
    body.credentials.forEach((c: any) => {
      expect(c.service).toBe('github');
    });
  });

  it('gets a vault credential by ID', async () => {
    const cred = await grantex.vault.get(credId);

    expect(cred.id).toBe(credId);
    expect(cred.principalId).toBe(principalId);
    expect(cred.service).toBe('github');
    expect(cred.credentialType).toBe('oauth2');
    // Should not expose raw tokens
    expect((cred as any).accessToken).toBeUndefined();
    expect((cred as any).refreshToken).toBeUndefined();
  });

  it('returns 404 for non-existent credential ID', async () => {
    await expect(grantex.vault.get('vault_nonexistent_000')).rejects.toThrow();
  });

  it('deletes a vault credential', async () => {
    await grantex.vault.delete(credId);

    // Verify it's gone
    await expect(grantex.vault.get(credId)).rejects.toThrow();
  });

  it('returns 404 when deleting an already-deleted credential', async () => {
    await expect(grantex.vault.delete(credId)).rejects.toThrow();
  });
});

describe('E2E: Vault Upsert Behavior', () => {
  it('upserts credential for same principal+service combination', async () => {
    const principalId = `vault-upsert-${Date.now()}`;

    // First store
    const first = await grantex.vault.store({
      principalId,
      service: 'datadog',
      accessToken: 'dd_original_token',
    });
    expect(first.id).toBeDefined();

    // Second store with same principal+service should upsert
    const second = await grantex.vault.store({
      principalId,
      service: 'datadog',
      accessToken: 'dd_updated_token',
    });
    expect(second.id).toBeDefined();

    // Should only have one credential for this principal+service
    const res = await fetch(
      `${BASE_URL}/v1/vault/credentials?principalId=${principalId}&service=datadog`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    const body = (await res.json()) as { credentials: any[] };
    expect(body.credentials.length).toBe(1);
  });
});

describe('E2E: Vault Validation', () => {
  it('rejects store without principalId', async () => {
    const res = await fetch(`${BASE_URL}/v1/vault/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ service: 'test', accessToken: 'tok' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects store without service', async () => {
    const res = await fetch(`${BASE_URL}/v1/vault/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ principalId: 'user', accessToken: 'tok' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects store without accessToken', async () => {
    const res = await fetch(`${BASE_URL}/v1/vault/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ principalId: 'user', service: 'test' }),
    });
    expect(res.status).toBe(400);
  });
});
