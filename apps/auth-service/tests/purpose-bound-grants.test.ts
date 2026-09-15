import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { decodeJwt } from 'jose';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth, sqlMock, mockRedis, TEST_AGENT, TEST_DEVELOPER } from './helpers.js';
import { signGrantToken } from '../src/lib/crypto.js';
import {
  buildToolsAuthorizationDetails,
  connectorsInScopes,
  describePurpose,
  isKnownPurpose,
  narrowToolsAuthorizationDetails,
  PURPOSE_VOCABULARY,
  purposeOfToolsAuthorizationDetails,
} from '../src/lib/purpose.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const TOOL_SCOPES = ['tool:acme_kyb:read', 'tool:acme_kyb:write', 'files:read'];
const DETAILS = [{ type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.cdd.onboarding' }];

function sqlCall(fragment: string): unknown[] | undefined {
  return sqlMock.mock.calls.find((call) => {
    const strings = call[0];
    return (Array.isArray(strings) ? strings.join('?') : String(strings)).includes(fragment);
  });
}

function sqlText(): string {
  return sqlMock.mock.calls
    .map(([strings]) => (Array.isArray(strings) ? strings.join('?') : String(strings)))
    .join('\n');
}

describe('POST /v1/authorize with purpose', () => {
  function seedAuthorize(): void {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // subscription
    sqlMock.mockResolvedValueOnce([{ count: '0' }]); // grant count
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id }]); // agent
    sqlMock.mockResolvedValueOnce([]); // policies
    sqlMock.mockResolvedValueOnce([]); // insert
  }

  it('persists the purpose and the tools authorization_details it will issue', async () => {
    seedAuthorize();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: TOOL_SCOPES, purpose: 'aml.cdd.onboarding' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ purpose: string }>().purpose).toBe('aml.cdd.onboarding');
    const insert = sqlCall('INSERT INTO auth_requests');
    expect(insert).toBeDefined();
    expect((insert![0] as string[]).join('?')).toContain('purpose, authorization_details');
    expect(insert!.slice(1)).toContain('aml.cdd.onboarding');
    expect(insert!.slice(1)).toContainEqual(DETAILS);
  });

  it('accepts a private purpose term', async () => {
    seedAuthorize();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: TOOL_SCOPES, purpose: 'x-acme-bank.kyb_refresh' },
    });
    expect(res.statusCode).toBe(201);
  });

  it.each([['marketing.enrichment'], ['AML.screening'], ['aml.cdd.*'], [''], [42]])(
    'rejects purpose %j before touching the database',
    async (purpose) => {
      seedAuth();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/authorize',
        headers: authHeader(),
        payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: TOOL_SCOPES, purpose },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('INVALID_PURPOSE');
      expect(sqlText()).not.toContain('INSERT INTO auth_requests');
    },
  );

  it('rejects a purpose when no scope names a connector', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: ['files:read'], purpose: 'aml.screening' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string; message: string }>()).toMatchObject({
      code: 'INVALID_PURPOSE',
      message: 'purpose requires at least one tool:<connector>:<permission> scope',
    });
  });

  it('requests without purpose store none', async () => {
    seedAuthorize();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/authorize',
      headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: TOOL_SCOPES },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<Record<string, unknown>>()).not.toHaveProperty('purpose');
    const insert = sqlCall('INSERT INTO auth_requests');
    expect(insert!.slice(-2)).toEqual([null, null]);
  });
});

describe('POST /v1/token carries purpose into the grant and token', () => {
  const approved = {
    id: 'areq_PURPOSE',
    agent_id: TEST_AGENT.id,
    principal_id: 'user_123',
    developer_id: TEST_DEVELOPER.id,
    scopes: TOOL_SCOPES,
    expires_in: '24h',
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    status: 'approved',
    agent_did: TEST_AGENT.did,
    redirect_uri: null,
    code_challenge: null,
    agent_key_thumbprint: null,
    purpose: 'aml.cdd.onboarding',
    authorization_details: DETAILS,
  };

  it('issues authorization_details with the purpose and stores it on the grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([approved]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-123', agentId: TEST_AGENT.id },
    });

    expect(res.statusCode).toBe(201);
    const claims = decodeJwt(res.json<{ grantToken: string }>().grantToken);
    expect(claims['authorization_details']).toEqual(DETAILS);
    const insert = sqlCall('INSERT INTO grants');
    expect((insert![0] as string[]).join('?')).toContain('purpose, authorization_details');
    expect(insert!.slice(-2)).toEqual(['aml.cdd.onboarding', DETAILS]);
  });

  it('issues no authorization_details for a request without purpose', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...approved, purpose: null, authorization_details: null }]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-123', agentId: TEST_AGENT.id },
    });
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)).not.toHaveProperty('authorization_details');
  });

  it.each([
    ['purpose without entries', { authorization_details: null }],
    ['entries with another purpose', { authorization_details: [{ ...DETAILS[0], purpose: 'payments.payout' }] }],
    ['unknown stored purpose', { purpose: 'marketing.enrichment', authorization_details: [{ ...DETAILS[0], purpose: 'marketing.enrichment' }] }],
    ['entries without purpose', { purpose: null }],
  ])('refuses to issue and keeps the code when the request is inconsistent: %s', async (_name, patch) => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...approved, ...patch }]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/token',
      headers: authHeader(),
      payload: { code: 'code-123', agentId: TEST_AGENT.id },
    });
    expect(res.statusCode).toBe(500);
    expect(sqlText()).not.toContain('INSERT INTO grants');
    expect(sqlText()).not.toContain('UPDATE auth_requests');
  });
});

describe('POST /v1/token/refresh keeps the purpose', () => {
  const refreshRow = {
    refresh_id: 'ref_EXISTING',
    grant_id: 'grnt_EXISTING',
    is_used: false,
    refresh_expires_at: new Date(Date.now() + 86400_000 * 30).toISOString(),
    used_at: null,
    rotated_to_token_id: null,
    replay_expires_at: null,
    replay_request_hash: null,
    replay_jti: null,
    replay_issued_at: null,
    replay_grant_token: null,
    agent_id: TEST_AGENT.id,
    principal_id: 'user_123',
    developer_id: TEST_DEVELOPER.id,
    scopes: TOOL_SCOPES,
    grant_status: 'active',
    grant_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    agent_did: TEST_AGENT.did,
    agent_key_thumbprint: null,
    grant_authorization_details: DETAILS,
  };

  async function refresh(row: Record<string, unknown>) {
    seedAuth();
    sqlMock.mockResolvedValueOnce([row]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'ref_EXISTING' }]);
    sqlMock.mockResolvedValueOnce([]);
    return app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: { ...authHeader(), 'idempotency-key': 'refresh-attempt-purpose-000000001' },
      payload: { refreshToken: 'ref_EXISTING', agentId: TEST_AGENT.id },
    });
  }

  it('re-issues the grant tools entries', async () => {
    const res = await refresh(refreshRow);
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)['authorization_details']).toEqual(DETAILS);
  });

  it('keeps the tools entries alongside the budget entry', async () => {
    const res = await refresh({ ...refreshRow, remaining_budget: '25.00', budget_currency: 'USD' });
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)['authorization_details']).toEqual([
      ...DETAILS,
      { type: 'urn:grantex:params:oauth:authorization-details:budget', amount: '25.00', currency: 'USD' },
    ]);
  });

  it('refuses a grant whose stored authorization_details are corrupt', async () => {
    const res = await refresh({ ...refreshRow, grant_authorization_details: { purpose: 'aml.screening' } });
    expect(res.statusCode).toBe(500);
  });
});

describe('POST /v1/grants/delegate inherits the purpose', () => {
  const SUB_AGENT = {
    id: 'ag_SUBAGENT01',
    did: 'did:grantex:ag_SUBAGENT01',
    developer_id: TEST_DEVELOPER.id,
    scopes: [],
    status: 'active',
  };

  async function delegate(parentDetails: unknown, scopes: string[]) {
    const parentToken = await signGrantToken({
      sub: 'user_123',
      agt: TEST_AGENT.did,
      dev: TEST_DEVELOPER.id,
      scp: ['tool:acme_kyb:read', 'tool:other_kyb:read', 'files:read'],
      jti: 'tok_PARENT01',
      grnt: 'grnt_PARENT01',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(parentDetails !== undefined ? { authorizationDetails: parentDetails as Array<Record<string, unknown>> } : {}),
    });
    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    sqlMock.mockResolvedValueOnce([{ is_revoked: false, expires_at: new Date(Date.now() + 3600_000).toISOString(), grant_status: 'active' }]);
    sqlMock.mockResolvedValueOnce([SUB_AGENT]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_PARENT01' }]);
    return app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: { parentGrantToken: parentToken, subAgentId: SUB_AGENT.id, scopes, expiresIn: '1h' },
    });
  }

  const parentDetails = [
    { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' },
    { type: 'urn:grantex:tools:v1', connector: 'other_kyb', purpose: 'aml.screening' },
    { type: 'urn:grantex:params:oauth:authorization-details:budget', amount: '5', currency: 'USD' },
  ];

  it('keeps the parent tools entries for the delegated connectors only', async () => {
    const res = await delegate(parentDetails, ['tool:acme_kyb:read']);
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)['authorization_details']).toEqual([parentDetails[0]]);
    const insert = sqlCall('INSERT INTO grants');
    expect(insert!.slice(-2)).toEqual(['aml.screening', [parentDetails[0]]]);
  });

  it('records the parent purpose even when no delegated scope names a connector', async () => {
    const res = await delegate(parentDetails, ['files:read']);
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)).not.toHaveProperty('authorization_details');
    expect(sqlCall('INSERT INTO grants')!.slice(-2)).toEqual(['aml.screening', null]);
  });

  it('a parent without purpose yields a child without purpose', async () => {
    const res = await delegate(undefined, ['tool:acme_kyb:read']);
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)).not.toHaveProperty('authorization_details');
    expect(sqlCall('INSERT INTO grants')!.slice(-2)).toEqual([null, null]);
  });

  it('rejects a parent whose tools entries disagree on purpose', async () => {
    const res = await delegate(
      [parentDetails[0], { ...parentDetails[1], purpose: 'payments.payout' }],
      ['tool:acme_kyb:read'],
    );
    expect(res.statusCode).toBe(400);
    expect(sqlText()).not.toContain('INSERT INTO grants');
  });
});

describe('consent shows the purpose', () => {
  it('GET /v1/consent/:id returns the purpose and a label', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      scopes: TOOL_SCOPES,
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      status: 'pending',
      redirect_uri: null,
      state: null,
      agent_name: 'Underwriting Agent',
      agent_description: null,
      agent_did: 'did:grantex:ag_TEST01AGENTID',
      purpose: 'aml.cdd.onboarding',
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/consent/areq_TEST01' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      purpose: 'aml.cdd.onboarding',
      purposeDescription: 'Customer due diligence at onboarding (aml.cdd.onboarding)',
    });
  });

  it('GET /v1/consent/:id omits purpose when the request has none', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      scopes: ['calendar:read'],
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      status: 'pending',
      agent_name: 'Agent',
      agent_did: 'did:grantex:ag_TEST01AGENTID',
      purpose: null,
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/consent/areq_TEST01' });
    expect(res.json()).not.toHaveProperty('purpose');
  });

  /**
   * Serve the consent page, run its script against the real GET
   * /v1/consent/:id response with a minimal DOM, and return the HTML it renders.
   */
  async function renderConsentPage(row: Record<string, unknown>): Promise<string> {
    const page = await app.inject({ method: 'GET', url: '/consent?req=areq_TEST01' });
    const scriptStart = page.body.indexOf('<script>') + '<script>'.length;
    const script = page.body.slice(scriptStart, page.body.indexOf('</script>', scriptStart));
    expect(scriptStart).toBeGreaterThanOrEqual('<script>'.length);
    sqlMock.mockResolvedValueOnce([row]);
    const content = { innerHTML: '<div class="spinner"></div>' };
    const button = { disabled: false, addEventListener: () => undefined };
    const context = vm.createContext({
      URLSearchParams,
      Date,
      Math,
      String,
      JSON,
      Uint8Array,
      atob,
      btoa,
      location: { search: '?req=areq_TEST01', href: 'https://auth.example.com/consent?req=areq_TEST01' },
      navigator: {},
      document: { getElementById: (id: string) => (id === 'content' ? content : button) },
      fetch: async (url: string) => {
        const res = await app.inject({ method: 'GET', url });
        return { ok: res.statusCode < 400, status: res.statusCode, json: async () => res.json() };
      },
    });
    vm.runInContext(script, context);
    for (let i = 0; i < 50 && content.innerHTML.includes('spinner'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return content.innerHTML;
  }

  const consentRow = {
    id: 'areq_TEST01',
    scopes: TOOL_SCOPES,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    status: 'pending',
    redirect_uri: null,
    state: null,
    agent_name: 'Underwriting Agent',
    agent_description: null,
    agent_did: 'did:grantex:ag_TEST01AGENTID',
    purpose: 'aml.cdd.onboarding',
  };

  it('the rendered consent page shows the purpose label above the permissions', async () => {
    const html = await renderConsentPage(consentRow);
    expect(html).toContain(
      '<div class="purpose" id="purpose">Customer due diligence at onboarding (aml.cdd.onboarding)</div>',
    );
    expect(html).toContain('The agent may use this access only for this purpose.');
    expect(html.indexOf('id="purpose"')).toBeLessThan(html.indexOf('Requested permissions'));
  });

  it('the rendered consent page escapes a stored purpose', async () => {
    const html = await renderConsentPage({ ...consentRow, purpose: 'x-acme.<img src=x onerror=alert(1)>' });
    expect(html).toContain('x-acme.&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('the rendered consent page has no purpose block without a purpose', async () => {
    const html = await renderConsentPage({ ...consentRow, purpose: null });
    expect(html).toContain('Requested permissions');
    expect(html).not.toContain('id="purpose"');
  });
});

describe('audit entries record the grant purpose', () => {
  it('POST /v1/audit/log stamps the purpose from the grant', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // subscription
    sqlMock.mockResolvedValueOnce([]); // advisory lock
    sqlMock.mockResolvedValueOnce([{ count: '0' }]); // count
    sqlMock.mockResolvedValueOnce([]); // last hash
    sqlMock.mockResolvedValueOnce([{
      id: 'alog_01',
      agent_id: TEST_AGENT.id,
      agent_did: TEST_AGENT.did,
      grant_id: 'grnt_01',
      principal_id: 'user_123',
      developer_id: TEST_DEVELOPER.id,
      action: 'acme_kyb.resolve_business',
      metadata: {},
      hash: 'h',
      previous_hash: null,
      timestamp: new Date().toISOString(),
      status: 'success',
      purpose: 'aml.cdd.onboarding',
    }]);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audit/log',
      headers: authHeader(),
      payload: {
        agentId: TEST_AGENT.id,
        agentDid: TEST_AGENT.did,
        grantId: 'grnt_01',
        principalId: 'user_123',
        action: 'acme_kyb.resolve_business',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ purpose: string }>().purpose).toBe('aml.cdd.onboarding');
    const insert = sqlCall('INSERT INTO audit_entries');
    expect((insert![0] as string[]).join('?')).toContain('SELECT g.purpose FROM grants g WHERE g.id = ?');
  });
});

describe('GET /v1/grants/:id returns the purpose', () => {
  it('includes purpose when the grant has one', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'grnt_01',
      agent_id: TEST_AGENT.id,
      principal_id: 'user_123',
      developer_id: TEST_DEVELOPER.id,
      scopes: TOOL_SCOPES,
      status: 'active',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      revoked_at: null,
      purpose: 'aml.screening',
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/grants/grnt_01', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ purpose: string }>().purpose).toBe('aml.screening');
  });
});

describe('purpose vocabulary matches the SDKs', () => {
  const fixtures = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'purpose-matching.json'), 'utf-8'),
  ) as { vocabulary: string[]; known_cases: Array<{ purpose: string; known: boolean }> };

  it('has the same vocabulary', () => {
    expect([...PURPOSE_VOCABULARY.keys()].sort()).toEqual([...fixtures.vocabulary].sort());
  });

  for (const c of fixtures.known_cases) {
    it(`isKnownPurpose(${JSON.stringify(c.purpose)}) is ${c.known}`, () => {
      expect(isKnownPurpose(c.purpose)).toBe(c.known);
    });
  }
});

describe('purpose library', () => {
  it('knows the vocabulary and private terms', () => {
    for (const p of ['aml.cdd.onboarding', 'aml.cdd.ongoing', 'aml.screening', 'procurement.vendor_onboarding', 'payments.payout', 'x-acme-bank.kyb_refresh']) {
      expect(isKnownPurpose(p), p).toBe(true);
    }
    for (const p of ['marketing.enrichment', 'aml', 'x-acme', 'aml.cdd.*', 'Aml.screening', '', null]) {
      expect(isKnownPurpose(p), String(p)).toBe(false);
    }
  });

  it('describes purposes', () => {
    expect(describePurpose('payments.payout')).toBe('Payouts (payments.payout)');
    expect(describePurpose('x-acme-bank.kyb_refresh')).toBe('x-acme-bank.kyb_refresh');
  });

  it('finds connectors in connector-scoped scopes', () => {
    expect(connectorsInScopes(['tool:acme_kyb:read', 'agenticorg:other_kyb:write', 'tool:acme_kyb:write:*', 'files:read', 'tool:bad name:read']))
      .toEqual(['acme_kyb', 'other_kyb']);
  });

  it('builds one entry per connector', () => {
    expect(buildToolsAuthorizationDetails('aml.screening', ['tool:acme_kyb:read', 'tool:other_kyb:read'])).toEqual([
      { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' },
      { type: 'urn:grantex:tools:v1', connector: 'other_kyb', purpose: 'aml.screening' },
    ]);
  });

  it('narrows and reads stored entries, failing on corrupt input', () => {
    expect(narrowToolsAuthorizationDetails(null, ['tool:acme_kyb:read'])).toEqual([]);
    expect(() => narrowToolsAuthorizationDetails({}, ['tool:acme_kyb:read'])).toThrow();
    expect(purposeOfToolsAuthorizationDetails([])).toBeUndefined();
    expect(() => purposeOfToolsAuthorizationDetails([{ purpose: 1 }])).toThrow();
  });
});

describe('migration 095', () => {
  it('adds nullable purpose columns without touching existing rows', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'db', 'migrations', '095_purpose_bound_grants.sql');
    const text = readFileSync(file, 'utf-8');
    for (const table of ['auth_requests', 'grants', 'audit_entries']) {
      expect(text).toMatch(new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN IF NOT EXISTS purpose TEXT;`));
    }
    expect(text).not.toMatch(/\b(DROP|UPDATE|DELETE|NOT NULL)\b/);
  });
});
