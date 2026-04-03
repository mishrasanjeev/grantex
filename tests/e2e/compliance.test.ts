/**
 * E2E Tests: Compliance Reporting
 *
 * Tests compliance summary, export grants, export audit,
 * evidence pack, filtering by date range and status.
 * Run: npx vitest run tests/e2e/compliance.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;
let agentId: string;
let grantId: string;

async function authorizeAndExchange(agentId: string, scopes: string[]) {
  const auth = await grantex.authorize({ agentId, userId: `compliance-user-${Date.now()}`, scopes });
  const code = ('code' in auth && typeof (auth as any).code === 'string')
    ? (auth as any).code
    : await fetch(`${BASE_URL}/v1/authorize/${auth.authRequestId}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: '{}',
      }).then(r => r.json()).then((d: any) => d.code);
  return grantex.tokens.exchange({ code, agentId });
}

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-compliance-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  // Register an agent and create a grant to have data for compliance reports
  const agent = await grantex.agents.register({ name: `comp-agent-${Date.now()}`, scopes: ['files:read', 'email:send'] });
  agentId = agent.agentId;

  const token = await authorizeAndExchange(agentId, ['files:read']);
  grantId = token.grantId;

  // Log some audit entries
  await grantex.audit.log({
    agentId,
    agentDid: agent.did,
    grantId,
    principalId: 'compliance-user',
    action: 'compliance.test.action',
    metadata: { test: true },
  });
});

describe('E2E: Compliance Summary', () => {
  it('gets compliance summary with all sections', async () => {
    const summary = await grantex.compliance.summary();

    expect(summary).toBeDefined();
    expect(summary).toHaveProperty('generatedAt');
    expect(typeof summary.generatedAt).toBe('string');

    // Agents section
    expect(summary).toHaveProperty('agents');
    expect(summary.agents).toHaveProperty('total');
    expect(summary.agents).toHaveProperty('active');
    expect(summary.agents).toHaveProperty('suspended');
    expect(summary.agents).toHaveProperty('revoked');
    expect(typeof summary.agents.total).toBe('number');
    expect(summary.agents.total).toBeGreaterThanOrEqual(1);

    // Grants section
    expect(summary).toHaveProperty('grants');
    expect(summary.grants).toHaveProperty('total');
    expect(summary.grants).toHaveProperty('active');
    expect(summary.grants).toHaveProperty('revoked');
    expect(summary.grants).toHaveProperty('expired');
    expect(summary.grants.total).toBeGreaterThanOrEqual(1);

    // Audit section
    expect(summary).toHaveProperty('auditEntries');
    expect(summary.auditEntries).toHaveProperty('total');
    expect(summary.auditEntries).toHaveProperty('success');
    expect(summary.auditEntries).toHaveProperty('failure');
    expect(summary.auditEntries).toHaveProperty('blocked');

    // Policies section
    expect(summary).toHaveProperty('policies');
    expect(summary.policies).toHaveProperty('total');

    // Plan
    expect(summary).toHaveProperty('plan');
    expect(typeof summary.plan).toBe('string');
  });

  it('gets compliance summary with date filters', async () => {
    const since = new Date(Date.now() - 86400000 * 7).toISOString();
    const until = new Date().toISOString();

    const res = await fetch(`${BASE_URL}/v1/compliance/summary?since=${since}&until=${until}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const summary = (await res.json()) as any;
    expect(summary.since).toBe(since);
    expect(summary.until).toBe(until);
    expect(summary.agents).toBeDefined();
  });
});

describe('E2E: Compliance Export Grants', () => {
  it('exports all grants', async () => {
    const result = await grantex.compliance.exportGrants();

    expect(result).toBeDefined();
    expect(result).toHaveProperty('generatedAt');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('grants');
    expect(Array.isArray(result.grants)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(1);

    // Verify grant shape in export
    const grant = result.grants[0];
    expect(grant).toHaveProperty('grantId');
    expect(grant).toHaveProperty('agentId');
    expect(grant).toHaveProperty('principalId');
    expect(grant).toHaveProperty('scopes');
    expect(grant).toHaveProperty('status');
    expect(grant).toHaveProperty('issuedAt');
    expect(grant).toHaveProperty('expiresAt');
    expect(grant).toHaveProperty('delegationDepth');
  });

  it('exports grants with status filter', async () => {
    const res = await fetch(`${BASE_URL}/v1/compliance/export/grants?status=active`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;
    expect(body.grants).toBeDefined();
    body.grants.forEach((g: any) => {
      expect(g.status).toBe('active');
    });
  });

  it('exports grants with date range', async () => {
    const since = new Date(Date.now() - 86400000).toISOString();
    const res = await fetch(`${BASE_URL}/v1/compliance/export/grants?since=${since}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;
    expect(body.total).toBeGreaterThanOrEqual(0);
  });
});

describe('E2E: Compliance Export Audit', () => {
  it('exports audit entries', async () => {
    const result = await grantex.compliance.exportAudit();

    expect(result).toBeDefined();
    expect(result).toHaveProperty('generatedAt');
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('entries');
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('exports audit entries with agentId filter', async () => {
    const res = await fetch(`${BASE_URL}/v1/compliance/export/audit?agentId=${agentId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;
    expect(body.entries).toBeDefined();
    body.entries.forEach((e: any) => {
      expect(e.agentId).toBe(agentId);
    });
  });

  it('exports audit entries with status filter', async () => {
    const res = await fetch(`${BASE_URL}/v1/compliance/export/audit?status=success`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;
    body.entries.forEach((e: any) => {
      expect(e.status).toBe('success');
    });
  });

  it('audit entries have hash chain fields', async () => {
    const result = await grantex.compliance.exportAudit();
    if (result.entries.length > 0) {
      const entry = result.entries[0];
      expect(entry).toHaveProperty('hash');
      expect(typeof entry.hash).toBe('string');
      // First entry might not have a prevHash
      expect(entry).toHaveProperty('prevHash');
    }
  });
});

describe('E2E: Evidence Pack', () => {
  it('generates a comprehensive evidence pack', async () => {
    const res = await fetch(`${BASE_URL}/v1/compliance/evidence-pack`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as any;

    expect(body).toHaveProperty('meta');
    expect(body.meta).toHaveProperty('schemaVersion');
    expect(body.meta).toHaveProperty('generatedAt');
    expect(body.meta).toHaveProperty('framework');

    expect(body).toHaveProperty('summary');
    expect(body.summary).toHaveProperty('agents');
    expect(body.summary).toHaveProperty('grants');
    expect(body.summary).toHaveProperty('auditEntries');
    expect(body.summary).toHaveProperty('policies');
    expect(body.summary).toHaveProperty('plan');

    expect(body).toHaveProperty('grants');
    expect(Array.isArray(body.grants)).toBe(true);

    expect(body).toHaveProperty('auditEntries');
    expect(Array.isArray(body.auditEntries)).toBe(true);

    expect(body).toHaveProperty('policies');
    expect(Array.isArray(body.policies)).toBe(true);

    expect(body).toHaveProperty('chainIntegrity');
    expect(body.chainIntegrity).toHaveProperty('valid');
    expect(body.chainIntegrity).toHaveProperty('checkedEntries');
  });
});
