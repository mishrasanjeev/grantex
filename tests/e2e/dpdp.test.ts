/**
 * E2E Tests: DPDP / Data Protection
 *
 * Tests consent notice creation, consent record creation and withdrawal,
 * grievance filing, data principal access, and compliance exports.
 * Run: npx vitest run tests/e2e/dpdp.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;
let grantId: string;
let agentId: string;
const dataPrincipalId = `principal-${Date.now()}`;
let noticeId: string;

async function authorizeAndExchange(agentId: string, scopes: string[]) {
  const auth = await grantex.authorize({ agentId, userId: `dpdp-user-${Date.now()}`, scopes });
  const code = ('code' in auth && typeof (auth as any).code === 'string')
    ? (auth as any).code
    : await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: '{}',
      }).then(r => r.json()).then((d: any) => d.code);
  return grantex.tokens.exchange({ code, agentId });
}

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-dpdp-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  const agent = await grantex.agents.register({ name: `dpdp-agent-${Date.now()}`, scopes: ['files:read', 'email:send'] });
  agentId = agent.agentId;
  const token = await authorizeAndExchange(agentId, ['files:read']);
  grantId = token.grantId;
});

describe('E2E: DPDP Consent Notices', () => {
  it('creates a consent notice', async () => {
    noticeId = `notice-${Date.now()}`;
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-notices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        noticeId,
        version: '1.0',
        title: 'Data Processing Notice',
        content: 'We process your data for service improvement and analytics.',
        purposes: [
          { code: 'service', description: 'Service improvement' },
          { code: 'analytics', description: 'Usage analytics' },
        ],
        language: 'en',
        dataFiduciaryContact: 'privacy@example.com',
        grievanceOfficer: { name: 'Jane Smith', email: 'grievance@example.com', phone: '+1234567890' },
      }),
    });
    expect(res.status).toBe(201);
    const notice = (await res.json()) as any;
    expect(notice.noticeId).toBe(noticeId);
    expect(notice.version).toBe('1.0');
    expect(notice.language).toBe('en');
    expect(notice.contentHash).toBeDefined();
    expect(typeof notice.contentHash).toBe('string');
    expect(notice.createdAt).toBeDefined();
  });

  it('rejects duplicate notice version', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-notices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        noticeId,
        version: '1.0',
        title: 'Same notice',
        content: 'Duplicate content',
        purposes: [{ code: 'service', description: 'Service' }],
      }),
    });
    expect(res.status).toBe(409);
  });

  it('creates a second version of the same notice', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-notices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        noticeId,
        version: '2.0',
        title: 'Updated Data Processing Notice',
        content: 'We process your data for service improvement, analytics, and compliance.',
        purposes: [
          { code: 'service', description: 'Service improvement' },
          { code: 'analytics', description: 'Usage analytics' },
          { code: 'compliance', description: 'Regulatory compliance' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const notice = (await res.json()) as any;
    expect(notice.version).toBe('2.0');
  });

  it('rejects notice without required fields', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-notices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ noticeId: 'incomplete' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('E2E: DPDP Consent Records', () => {
  let recordId: string;

  it('creates a consent record linked to a grant', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        grantId,
        dataPrincipalId,
        purposes: [
          { code: 'service', description: 'Service improvement' },
          { code: 'analytics', description: 'Usage analytics' },
        ],
        consentNoticeId: noticeId,
        processingExpiresAt: new Date(Date.now() + 86400000 * 365).toISOString(),
      }),
    });
    expect(res.status).toBe(201);
    const record = (await res.json()) as any;
    recordId = record.recordId;

    expect(record.recordId).toBeDefined();
    expect(typeof record.recordId).toBe('string');
    expect(record.grantId).toBe(grantId);
    expect(record.dataPrincipalId).toBe(dataPrincipalId);
    expect(record.status).toBe('active');
    expect(record.consentNoticeHash).toBeDefined();
    expect(typeof record.consentNoticeHash).toBe('string');
    expect(record.consentProof).toBeDefined();
    expect(record.processingExpiresAt).toBeDefined();
    expect(record.retentionUntil).toBeDefined();
    expect(record.createdAt).toBeDefined();
  });

  it('rejects consent record without required fields', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ grantId }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects consent record with invalid grant', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        grantId: 'grnt_nonexistent_000',
        dataPrincipalId,
        purposes: [{ code: 'test', description: 'Test' }],
        consentNoticeId: noticeId,
        processingExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    expect(res.status).toBe(400);
  });

  it('provides data principal access to their records', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/data-principals/${dataPrincipalId}/records`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;

    expect(body.dataPrincipalId).toBe(dataPrincipalId);
    expect(body.records).toBeDefined();
    expect(Array.isArray(body.records)).toBe(true);
    expect(body.records.length).toBeGreaterThanOrEqual(1);
    expect(body.totalRecords).toBeGreaterThanOrEqual(1);

    // Verify record shape
    const record = body.records[0];
    expect(record).toHaveProperty('recordId');
    expect(record).toHaveProperty('grantId');
    expect(record).toHaveProperty('purposes');
    expect(record).toHaveProperty('scopes');
    expect(record).toHaveProperty('status');
    expect(record).toHaveProperty('accessCount');
    expect(record.accessCount).toBeGreaterThanOrEqual(1);
  });

  it('withdraws consent', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-records/${recordId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        reason: 'User no longer wishes data to be processed',
        revokeGrant: false,
        deleteProcessedData: true,
      }),
    });
    expect(res.ok).toBe(true);
    const result = (await res.json()) as any;

    expect(result.recordId).toBe(recordId);
    expect(result.status).toBe('withdrawn');
    expect(result.withdrawnAt).toBeDefined();
    expect(result.grantRevoked).toBe(false);
    expect(result.dataDeleted).toBe(true);
  });

  it('rejects double withdrawal', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/consent-records/${recordId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ reason: 'Second attempt' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe('ALREADY_WITHDRAWN');
  });

  it('withdrawal with revokeGrant=true revokes the grant', async () => {
    // Create a new grant and consent for this test
    const token = await authorizeAndExchange(agentId, ['email:send']);

    const consentRes = await fetch(`${BASE_URL}/v1/dpdp/consent-records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        grantId: token.grantId,
        dataPrincipalId: `revoke-principal-${Date.now()}`,
        purposes: [{ code: 'service', description: 'Service' }],
        consentNoticeId: noticeId,
        processingExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      }),
    });
    expect(consentRes.status).toBe(201);
    const consentRecord = (await consentRes.json()) as any;

    // Withdraw with grant revocation
    const withdrawRes = await fetch(`${BASE_URL}/v1/dpdp/consent-records/${consentRecord.recordId}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ reason: 'Revoke grant too', revokeGrant: true }),
    });
    expect(withdrawRes.ok).toBe(true);
    const result = (await withdrawRes.json()) as any;
    expect(result.grantRevoked).toBe(true);

    // Verify the grant token is now invalid
    const verify = await grantex.tokens.verify(token.grantToken);
    expect(verify.valid).toBe(false);
  });
});

describe('E2E: DPDP Grievances', () => {
  let grievanceId: string;
  let referenceNumber: string;

  it('files a grievance', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/grievances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        dataPrincipalId,
        type: 'data-breach',
        description: 'Suspected unauthorized access to personal data',
        evidence: { incidentDate: '2026-04-01', affectedSystems: ['email', 'files'] },
      }),
    });
    expect(res.status).toBe(202);
    const grievance = (await res.json()) as any;
    grievanceId = grievance.grievanceId;
    referenceNumber = grievance.referenceNumber;

    expect(grievance.grievanceId).toBeDefined();
    expect(typeof grievance.grievanceId).toBe('string');
    expect(grievance.referenceNumber).toBeDefined();
    expect(grievance.referenceNumber).toMatch(/^GRV-\d{4}-\d{5}$/);
    expect(grievance.type).toBe('data-breach');
    expect(grievance.status).toBe('submitted');
    expect(grievance.expectedResolutionBy).toBeDefined();
    expect(grievance.createdAt).toBeDefined();

    // Expected resolution should be 7 days from now (within 1 day margin)
    const resolution = new Date(grievance.expectedResolutionBy);
    const sevenDaysFromNow = Date.now() + 7 * 86400000;
    expect(resolution.getTime()).toBeGreaterThan(sevenDaysFromNow - 86400000);
    expect(resolution.getTime()).toBeLessThan(sevenDaysFromNow + 86400000);
  });

  it('retrieves a grievance by ID', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/grievances/${grievanceId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const grievance = (await res.json()) as any;

    expect(grievance.grievanceId).toBe(grievanceId);
    expect(grievance.dataPrincipalId).toBe(dataPrincipalId);
    expect(grievance.type).toBe('data-breach');
    expect(grievance.description).toContain('unauthorized access');
    expect(grievance.status).toBe('submitted');
    expect(grievance.referenceNumber).toBe(referenceNumber);
    expect(grievance.evidence).toBeDefined();
    expect(grievance.resolvedAt).toBeNull();
    expect(grievance.resolution).toBeNull();
  });

  it('files a second grievance with different type', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/grievances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        dataPrincipalId,
        type: 'consent-violation',
        description: 'Data used beyond consented purposes',
      }),
    });
    expect(res.status).toBe(202);
    const grievance = (await res.json()) as any;
    expect(grievance.type).toBe('consent-violation');
    expect(grievance.referenceNumber).not.toBe(referenceNumber);
  });

  it('rejects grievance without required fields', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/grievances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ dataPrincipalId }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent grievance', async () => {
    const res = await fetch(`${BASE_URL}/v1/dpdp/grievances/grv_nonexistent_000`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
  });
});
