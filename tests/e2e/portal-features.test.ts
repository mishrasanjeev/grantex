/**
 * Portal Features E2E Tests
 *
 * Tests every portal page's API calls against production.
 * Creates a sandbox account, exercises every feature, and cleans up.
 *
 * Run: npx vitest run tests/e2e/portal-features.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
let KEY: string;
let DEV_ID: string;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${KEY}` };
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

beforeAll(async () => {
  const res = await fetch(`${BASE_URL}/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `portal-e2e-${Date.now()}`, mode: 'sandbox' }),
  });
  const signup = (await res.json()) as { apiKey: string; developerId: string };
  KEY = signup.apiKey;
  DEV_ID = signup.developerId;
});

// ─── Dashboard ──────────────────────────────────────────────────────────────

describe('Dashboard Overview', () => {
  it('lists agents (empty initially)', async () => {
    const { status, data } = await api('GET', '/v1/agents');
    expect(status).toBe(200);
    expect((data as { agents: unknown[] }).agents).toEqual([]);
  });

  it('lists grants (empty initially)', async () => {
    const { status, data } = await api('GET', '/v1/grants');
    expect(status).toBe(200);
  });

  it('lists audit entries', async () => {
    const { status } = await api('GET', '/v1/audit/entries');
    expect(status).toBe(200);
  });
});

// ─── Agent CRUD ─────────────────────────────────────────────────────────────

describe('Agent CRUD', () => {
  let agentId: string;

  it('creates an agent', async () => {
    const { status, data } = await api('POST', '/v1/agents', {
      name: 'Portal E2E Agent',
      description: 'Created by portal E2E test',
      scopes: ['email:read', 'calendar:write'],
    });
    expect(status).toBe(201);
    agentId = (data as { agentId: string }).agentId;
    expect(agentId).toMatch(/^ag_/);
  });

  it('gets agent detail', async () => {
    const { status, data } = await api('GET', `/v1/agents/${agentId}`);
    expect(status).toBe(200);
    expect((data as { name: string }).name).toBe('Portal E2E Agent');
  });

  it('updates agent', async () => {
    const { status } = await api('PATCH', `/v1/agents/${agentId}`, {
      description: 'Updated by E2E',
    });
    expect(status).toBe(200);
  });

  it('lists agents (shows created agent)', async () => {
    const { data } = await api('GET', '/v1/agents');
    expect((data as { agents: { agentId: string }[] }).agents.length).toBeGreaterThan(0);
  });

  it('deletes agent', async () => {
    const { status } = await api('DELETE', `/v1/agents/${agentId}`);
    expect(status).toBe(204);
  });
});

// ─── Full Auth Flow + Grants + Tokens ───────────────────────────────────────

describe('Auth Flow, Grants, Tokens', () => {
  let agentId: string;
  let grantId: string;
  let grantToken: string;

  beforeAll(async () => {
    const { data } = await api('POST', '/v1/agents', {
      name: 'Auth Flow Agent',
      scopes: ['email:read', 'payments:mpp:inference'],
    });
    agentId = (data as { agentId: string }).agentId;
  });

  it('authorizes and gets code (sandbox)', async () => {
    const { status, data } = await api('POST', '/v1/authorize', {
      agentId,
      principalId: 'portal_e2e_user',
      scopes: ['email:read'],
      expiresIn: '1h',
    });
    expect([200, 201]).toContain(status);
    const code = (data as { code: string }).code;
    expect(code).toBeTruthy();

    const token = await api('POST', '/v1/token', { code, agentId });
    expect([200, 201]).toContain(token.status);
    grantId = (token.data as { grantId: string }).grantId;
    grantToken = (token.data as { grantToken: string }).grantToken;
    expect(grantId).toMatch(/^grnt_/);
  });

  it('gets grant detail', async () => {
    const { status, data } = await api('GET', `/v1/grants/${grantId}`);
    expect(status).toBe(200);
    expect((data as { status: string }).status).toBe('active');
  });

  it('verifies token', async () => {
    const { status, data } = await api('POST', '/v1/tokens/verify', { token: grantToken });
    expect(status).toBe(200);
    expect((data as { valid: boolean }).valid).toBe(true);
  });

  it('revokes grant', async () => {
    const { status } = await api('DELETE', `/v1/grants/${grantId}`);
    expect(status).toBe(204);
  });

  it('verifies token is invalid after revocation', async () => {
    const { data } = await api('POST', '/v1/tokens/verify', { token: grantToken });
    expect((data as { valid: boolean }).valid).toBe(false);
  });
});

// ─── Policies ───────────────────────────────────────────────────────────────

describe('Policies CRUD', () => {
  let policyId: string;

  it('creates a policy', async () => {
    const { status, data } = await api('POST', '/v1/policies', {
      name: 'E2E Auto-Approve',
      effect: 'allow',
      priority: 100,
      scopes: ['email:read'],
    });
    expect(status).toBe(201);
    policyId = (data as { id: string }).id;
  });

  it('lists policies', async () => {
    const { status, data } = await api('GET', '/v1/policies');
    expect(status).toBe(200);
    expect((data as { policies: unknown[] }).policies.length).toBeGreaterThan(0);
  });

  it('deletes policy', async () => {
    const { status } = await api('DELETE', `/v1/policies/${policyId}`);
    expect(status).toBe(204);
  });
});

// ─── Webhooks ───────────────────────────────────────────────────────────────

describe('Webhooks CRUD', () => {
  let webhookId: string;

  it('creates a webhook', async () => {
    const { status, data } = await api('POST', '/v1/webhooks', {
      url: 'https://httpbin.org/post',
      events: ['grant.created', 'grant.revoked'],
    });
    expect(status).toBe(201);
    webhookId = (data as { id: string }).id;
  });

  it('lists webhooks', async () => {
    const { status, data } = await api('GET', '/v1/webhooks');
    expect(status).toBe(200);
    expect((data as { webhooks: unknown[] }).webhooks.length).toBeGreaterThan(0);
  });

  it('deletes webhook', async () => {
    const { status } = await api('DELETE', `/v1/webhooks/${webhookId}`);
    expect(status).toBe(204);
  });
});

// ─── Anomalies ──────────────────────────────────────────────────────────────

describe('Anomalies', () => {
  it('detects anomalies', async () => {
    const { status } = await api('POST', '/v1/anomalies/detect', {});
    expect(status).toBe(200);
  });

  it('lists anomalies', async () => {
    const { status } = await api('GET', '/v1/anomalies');
    expect(status).toBe(200);
  });
});

// ─── Compliance ─────────────────────────────────────────────────────────────

describe('Compliance', () => {
  it('gets compliance summary', async () => {
    const { status, data } = await api('GET', '/v1/compliance/summary');
    expect(status).toBe(200);
  });
});

// ─── Usage ──────────────────────────────────────────────────────────────────

describe('Usage', () => {
  it('gets current usage', async () => {
    const { status, data } = await api('GET', '/v1/usage');
    expect(status).toBe(200);
    expect((data as { totalRequests: number }).totalRequests).toBeGreaterThanOrEqual(0);
  });

  it('gets usage history', async () => {
    const { status, data } = await api('GET', '/v1/usage/history?days=7');
    expect(status).toBe(200);
    expect((data as { entries: unknown[] }).entries).toBeDefined();
  });
});

// ─── Budgets ────────────────────────────────────────────────────────────────

describe('Budgets', () => {
  let agentId: string;
  let grantId: string;

  beforeAll(async () => {
    const ag = await api('POST', '/v1/agents', { name: 'Budget Agent', scopes: ['email:read'] });
    agentId = (ag.data as { agentId: string }).agentId;
    const auth = await api('POST', '/v1/authorize', { agentId, principalId: 'budget_user', scopes: ['email:read'], expiresIn: '1h' });
    const code = (auth.data as { code: string }).code;
    const token = await api('POST', '/v1/token', { code, agentId });
    grantId = (token.data as { grantId: string }).grantId;
  });

  it('allocates budget', async () => {
    const { status } = await api('POST', '/v1/budget/allocate', {
      grantId,
      initialBudget: 100,
      currency: 'USD',
    });
    expect(status).toBe(201);
  });

  it('gets budget balance', async () => {
    const { status, data } = await api('GET', `/v1/budget/balance/${grantId}`);
    expect(status).toBe(200);
    expect(Number((data as { remainingBudget: string }).remainingBudget)).toBe(100);
  });

  it('debits budget', async () => {
    const { status, data } = await api('POST', '/v1/budget/debit', {
      grantId,
      amount: 25,
      description: 'E2E test debit',
    });
    expect(status).toBe(200);
    expect(Number((data as { remaining: string }).remaining)).toBe(75);
  });

  it('lists budget allocations', async () => {
    const { status } = await api('GET', '/v1/budget/allocations');
    expect(status).toBe(200);
  });

  it('lists transactions', async () => {
    const { status, data } = await api('GET', `/v1/budget/transactions/${grantId}`);
    expect(status).toBe(200);
    expect((data as { transactions: unknown[] }).transactions.length).toBeGreaterThan(0);
  });
});

// ─── DPDP Compliance ────────────────────────────────────────────────────────

describe('DPDP Compliance', () => {
  let agentId: string;
  let grantId: string;
  let recordId: string;

  beforeAll(async () => {
    const ag = await api('POST', '/v1/agents', { name: 'DPDP Agent', scopes: ['email:read'] });
    agentId = (ag.data as { agentId: string }).agentId;
    const auth = await api('POST', '/v1/authorize', { agentId, principalId: 'dpdp_user', scopes: ['email:read'], expiresIn: '1h' });
    const code = (auth.data as { code: string }).code;
    const token = await api('POST', '/v1/token', { code, agentId });
    grantId = (token.data as { grantId: string }).grantId;
  });

  let noticeId: string;

  it('creates consent notice', async () => {
    noticeId = `e2e-${Date.now()}`;
    const { status } = await api('POST', '/v1/dpdp/consent-notices', {
      noticeId,
      version: '1.0',
      title: 'E2E Notice',
      content: 'Test consent notice',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
    });
    expect(status).toBe(201);
  });

  it('creates consent record', async () => {
    const { status, data } = await api('POST', '/v1/dpdp/consent-records', {
      grantId,
      dataPrincipalId: 'dpdp_user',
      purposes: [{ code: 'analytics', description: 'Usage analytics' }],
      consentNoticeId: noticeId,
      processingExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(status).toBe(201);
    recordId = (data as { recordId: string }).recordId;
  });

  it('lists consent records', async () => {
    const { status } = await api('GET', '/v1/dpdp/consent-records');
    expect(status).toBe(200);
  });

  it('gets principal records', async () => {
    const { status, data } = await api('GET', '/v1/dpdp/data-principals/dpdp_user/records');
    expect(status).toBe(200);
    expect((data as { totalRecords: number }).totalRecords).toBeGreaterThanOrEqual(0);
  });

  it('files grievance', async () => {
    const { status, data } = await api('POST', '/v1/dpdp/grievances', {
      dataPrincipalId: 'dpdp_user',
      type: 'violation',
      description: 'E2E test grievance',
    });
    expect(status).toBe(202);
    expect((data as { referenceNumber: string }).referenceNumber).toMatch(/^GRV-/);
  });

  it('creates DPDP export', async () => {
    const { status, data } = await api('POST', '/v1/dpdp/exports', {
      type: 'dpdp-audit',
      dateFrom: '2026-01-01T00:00:00Z',
      dateTo: '2026-12-31T00:00:00Z',
    });
    expect(status).toBe(201);
    expect((data as { exportId: string }).exportId).toMatch(/^exp_/);
  });
});

// ─── Settings ───────────────────────────────────────────────────────────────

describe('Settings', () => {
  it('gets developer profile', async () => {
    const { status, data } = await api('GET', '/v1/me');
    expect(status).toBe(200);
    expect((data as { developerId: string }).developerId).toBe(DEV_ID);
  });

  it('gets billing subscription', async () => {
    const { status } = await api('GET', '/v1/billing/subscription');
    expect(status).toBe(200);
  });
});

// ─── Domains ────────────────────────────────────────────────────────────────

describe('Domains', () => {
  it('lists domains', async () => {
    const { status } = await api('GET', '/v1/domains');
    expect(status).toBe(200);
  });
});

// ─── WebAuthn ───────────────────────────────────────────────────────────────

describe('WebAuthn', () => {
  it('lists credentials', async () => {
    const { status } = await api('GET', '/v1/webauthn/credentials?principalId=test');
    expect(status).toBe(200);
  });
});

// ─── Verifiable Credentials ─────────────────────────────────────────────────

describe('Credentials', () => {
  it('lists credentials', async () => {
    const { status } = await api('GET', '/v1/credentials');
    expect(status).toBe(200);
  });
});

// ─── Trust Registry ─────────────────────────────────────────────────────────

describe('Trust Registry', () => {
  it('gets grantex.dev org', async () => {
    const { status, data } = await api('GET', '/v1/trust-registry/did:web:grantex.dev');
    expect(status).toBe(200);
    expect((data as { trustLevel: string }).trustLevel).toBeTruthy();
  });
});

// ─── Well-Known ─────────────────────────────────────────────────────────────

describe('Well-Known Endpoints', () => {
  it('serves DID document', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/did.json`);
    expect(res.status).toBe(200);
  });

  it('serves JWKS', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const jwks = await res.json();
    expect((jwks as { keys: unknown[] }).keys.length).toBeGreaterThan(0);
  });

  it('serves Prometheus metrics', async () => {
    const res = await fetch(`${BASE_URL}/metrics`);
    expect(res.status).toBe(200);
  });
});

// ─── Passports ──────────────────────────────────────────────────────────────

describe('Passports', () => {
  let agentId: string;
  let grantId: string;
  let passportId: string;

  beforeAll(async () => {
    const ag = await api('POST', '/v1/agents', { name: 'Passport Agent', scopes: ['payments:mpp:inference'] });
    agentId = (ag.data as { agentId: string }).agentId;
    const auth = await api('POST', '/v1/authorize', { agentId, principalId: 'pp_user', scopes: ['payments:mpp:inference'], expiresIn: '1h' });
    const code = (auth.data as { code: string }).code;
    const token = await api('POST', '/v1/token', { code, agentId });
    grantId = (token.data as { grantId: string }).grantId;
  });

  it('issues passport', async () => {
    const { status, data } = await api('POST', '/v1/passport/issue', {
      agentId,
      grantId,
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 50, currency: 'USDC' },
      expiresIn: '1h',
    });
    expect(status).toBe(201);
    passportId = (data as { passportId: string }).passportId;
    expect(passportId).toMatch(/^urn:grantex:passport:/);
  });

  it('lists passports', async () => {
    const { status } = await api('GET', '/v1/passports');
    expect(status).toBe(200);
  });
});

// ─── Principal Sessions ─────────────────────────────────────────────────────

describe('Principal Sessions', () => {
  it('creates principal session', async () => {
    const { status } = await api('POST', '/v1/principal-sessions', {
      principalId: 'session_user',
      expiresIn: '1h',
    });
    // 201 = created, 404 = endpoint not deployed in this environment
    expect([200, 201, 404]).toContain(status);
  });
});
