/**
 * E2E test: MPP Agent Passport — full flow against production auth service.
 *
 * Exercises:
 *   1. Register an agent with MPP scopes
 *   2. Authorize a user (sandbox mode — code returned directly)
 *   3. Exchange code for grant token
 *   4. Issue AgentPassportCredential
 *   5. Retrieve the passport by ID
 *   6. Revoke the passport
 *   7. Verify revoked passport returns correct status
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let apiKey: string;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.headers.get('content-type')?.includes('json')
    ? await res.json()
    : null;
  return { status: res.status, data: data as T };
}

describe('MPP Passport E2E Flow', () => {
  let agentId: string;
  let grantId: string;
  let passportId: string;

  beforeAll(async () => {
    const account = await Grantex.signup(
      { name: `e2e-mpp-${Date.now()}`, mode: 'sandbox' },
      { baseUrl: BASE_URL },
    );
    apiKey = account.apiKey;
  }, 60000);

  it('1. registers an agent with MPP scopes', async () => {
    const res = await api<{ agentId: string; did: string }>('POST', '/v1/agents', {
      name: `mpp-e2e-agent-${Date.now()}`,
      description: 'Agent for MPP passport E2E tests',
      scopes: ['payments:mpp:inference', 'payments:mpp:compute'],
    });

    expect(res.status).toBe(201);
    expect(res.data.agentId).toMatch(/^ag_/);
    agentId = res.data.agentId;
  });

  it('2. authorizes a user and exchanges code for grant token', async () => {
    const authRes = await api<{ code?: string; authRequestId: string }>('POST', '/v1/authorize', {
      agentId,
      principalId: `user-mpp-${Date.now()}`,
      scopes: ['payments:mpp:inference', 'payments:mpp:compute'],
      expiresIn: '1h',
    });

    expect(authRes.status).toBe(201);
    expect(authRes.data.code).toBeDefined();

    const tokenRes = await api<{ grantId: string; grantToken: string }>('POST', '/v1/token', {
      code: authRes.data.code,
      agentId,
    });

    expect(tokenRes.status).toBe(201);
    expect(tokenRes.data.grantId).toBeDefined();
    grantId = tokenRes.data.grantId;
  });

  it('3. issues AgentPassportCredential', async () => {
    const res = await api<{
      passportId: string;
      credential: Record<string, unknown>;
      encodedCredential: string;
      expiresAt: string;
    }>('POST', '/v1/passport/issue', {
      agentId,
      grantId,
      allowedMPPCategories: ['inference', 'compute'],
      maxTransactionAmount: { amount: 50, currency: 'USDC' },
      paymentRails: ['tempo'],
      expiresIn: '1h',
    });

    expect(res.status).toBe(201);
    expect(res.data.passportId).toMatch(/^urn:grantex:passport:/);
    expect(res.data.credential).toBeDefined();
    expect(res.data.encodedCredential).toBeTruthy();
    expect(res.data.expiresAt).toBeTruthy();

    passportId = res.data.passportId;
  });

  it('4. retrieves the passport by ID', async () => {
    const res = await api<{ status: string }>(
      'GET',
      `/v1/passport/${encodeURIComponent(passportId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('active');
  });

  it('5. revokes the passport', async () => {
    const res = await api<{ revoked: boolean; revokedAt: string }>(
      'POST',
      `/v1/passport/${encodeURIComponent(passportId)}/revoke`,
    );

    expect(res.status).toBe(200);
    expect(res.data.revoked).toBe(true);
    expect(res.data.revokedAt).toBeTruthy();
  });

  it('6. verifies revoked passport returns correct status', async () => {
    const res = await api<{ status: string }>(
      'GET',
      `/v1/passport/${encodeURIComponent(passportId)}`,
    );

    expect(res.status).toBe(200);
    expect(res.data.status).toBe('revoked');
  });
});
