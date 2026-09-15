/**
 * Decision-grant routes (PRD G-3) with the store mocked: the feature flag,
 * configuration failures, input validation, the administrator-only identity
 * provider API and fail-closed auditing of refused consumptions. Database
 * behaviour is covered by decision-grants-postgres.integration.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth, TEST_ADMIN_API_KEY } from './helpers.js';
import { DecisionError } from '../src/lib/decisions/policy.js';

vi.mock('../src/lib/decisions/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/decisions/store.js')>();
  return {
    ...actual,
    consumeDecisionGrants: vi.fn(),
    createDecisionRequest: vi.fn(),
    auditConsumeRefusal: vi.fn(),
    createApproverIdp: vi.fn(),
  };
});

const store = await import('../src/lib/decisions/store.js');
const metrics = await import('../src/lib/metrics.js');

const ACTION = { case_id: 'case_8841', action: 'case_decision', decision: 'decline', subject: 'gb:00000001' };
const REVIEW = { memo: { content: 'Registry active.' }, policyScore: { content: { tier: 'low' } } };

describe('decision grant routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.stubEnv('DECISION_GRANTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(store.consumeDecisionGrants).mockReset();
    vi.mocked(store.createDecisionRequest).mockReset();
    vi.mocked(store.auditConsumeRefusal).mockReset();
    vi.mocked(store.createApproverIdp).mockReset();
  });

  it('is off by default (DECISION_GRANTS_ENABLED unset)', async () => {
    vi.stubEnv('DECISION_GRANTS_ENABLED', '');
    for (const [method, url] of [['POST', '/v1/decisions/requests'], ['POST', '/v1/decisions/consume']] as const) {
      seedAuth();
      const res = await app.inject({ method, url, headers: authHeader(), payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'DECISION_GRANTS_DISABLED' });
    }
    expect((await app.inject({ method: 'GET', url: '/decisions/dreq_01K00000000000000000000000' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/decisions/login?request=x&idp=y' })).statusCode).toBe(404);
    const adminCall = await app.inject({ method: 'GET', url: '/v1/admin/developers/dev_TEST/decision-approver-idps', headers: { authorization: `Bearer ${TEST_ADMIN_API_KEY}` } });
    expect(adminCall.statusCode).toBe(404);
    expect(store.consumeDecisionGrants).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the step-up settings are invalid', async () => {
    vi.stubEnv('DECISION_STEP_UP_AMR', '');
    vi.stubEnv('DECISION_STEP_UP_ACR', '');
    seedAuth();
    const res = await app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: authHeader(), payload: { action: ACTION } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'DECISION_CONFIG_INVALID' });
  });

  it('has no developer-key endpoint to sign approvers in or approve', async () => {
    for (const url of ['/v1/decisions/approver-sessions', '/v1/decisions/requests/dreq_01K00000000000000000000000/approvals', '/v1/decisions/requests/dreq_01K00000000000000000000000/page-tickets']) {
      seedAuth();
      expect((await app.inject({ method: 'POST', url, headers: authHeader(), payload: {} })).statusCode, url).toBe(404);
    }
  });

  it('validates a decision request before touching the database', async () => {
    const base = { action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', ...REVIEW };
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...base, action: { ...ACTION, extra: 1 } }, /extra/],
      [{ ...base, action: { ...ACTION, subject: 'gb:‮10000000' } }, /format characters/],
      [{ ...base, connector: undefined }, /connector/],
      [{ ...base, caseVersion: undefined }, /caseVersion/],
      [{ ...base, approvalsRequired: 3 }, /approvalsRequired/],
      [{ ...base, fourEyesOn: ['decline'], approvalsRequired: 1 }, /contradicts/],
      [{ ...base, expiresInSeconds: 86_401 }, /expiresInSeconds/],
      [{ ...base, memo: undefined }, /memo/],
      [{ ...base, memo: { content: 'x', ref: 'a'.repeat(513) } }, /memo.ref/],
      [{ ...base, memo: { content: '' } }, /memo.content/],
      [{ ...base, memo: { content: 'x', hash: `sha256:${'A'.repeat(43)}` } }, /memo.hash/],
      [{ ...base, policyScore: { content: 'low' } }, /policyScore.content/],
    ];
    for (const [payload, message] of cases) {
      seedAuth();
      const res = await app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: authHeader(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(message);
    }
    seedAuth();
    const duplicate = await app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: '{"connector":"acme_kyb","connector":"other_kyb"}',
    });
    expect(duplicate.statusCode).toBe(400);
    expect(store.createDecisionRequest).not.toHaveBeenCalled();
  });

  it('derives four eyes from fourEyesOn and passes the review content hashes', async () => {
    vi.mocked(store.createDecisionRequest).mockImplementation(async (_sql, input) => ({
      created: true,
      request: {
        id: 'dreq_01K00000000000000000000000', developer_id: 'dev_TEST', case_id: ACTION.case_id, case_version: 'v1',
        connector: 'acme_kyb', action: input.action, action_hash: 'sha256:x', approvals_required: input.approvalsRequired,
        memo_ref: null, memo_content: input.review.memo, memo_hash: input.review.memoHash, policy_score_ref: null,
        policy_score: input.review.policyScore, policy_score_hash: input.review.policyScoreHash, agent_id: null, grant_id: null,
        status: 'pending', expires_at: new Date(Date.now() + 1000), created_at: new Date(), updated_at: new Date(),
      },
    }));
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: authHeader(),
      payload: { action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', fourEyesOn: ['decline'], ...REVIEW },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ approvalsRequired: 2, created: true, memoHash: expect.stringMatching(/^sha256:/), approvalPage: 'https://grantex.dev/decisions/dreq_01K00000000000000000000000' });
    expect(vi.mocked(store.createDecisionRequest).mock.calls[0]![1]).toMatchObject({ approvalsRequired: 2 });
  });

  it('counts consumed grants and passes the expected action and case version to the store', async () => {
    vi.mocked(store.consumeDecisionGrants).mockResolvedValue({ requestId: 'dreq_1', jtis: ['dgnt_a', 'dgnt_b'], approvers: [], actionHash: 'sha256:x' });
    vi.mocked(metrics.decisionGrantsConsumedTotal.inc).mockClear();
    seedAuth();
    const res = await app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: authHeader(), payload: { decisionGrants: ['a', 'b'], action: ACTION, caseVersion: 'v1' } });
    expect(res.statusCode).toBe(200);
    expect(metrics.decisionGrantsConsumedTotal.inc).toHaveBeenCalledWith(2);
    expect(vi.mocked(store.consumeDecisionGrants).mock.calls[0]![1]).toMatchObject({ developerId: 'dev_TEST', action: ACTION, caseVersion: 'v1' });
  });

  it('records every refused consumption with the attempted action, and fails the request when that record cannot be written', async () => {
    vi.mocked(store.consumeDecisionGrants).mockRejectedValue(new DecisionError('action_mismatch', 409, 'refused'));
    vi.mocked(metrics.decisionGrantsRejectedTotal.labels).mockClear();
    seedAuth();
    const refused = await app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: authHeader(), payload: { decisionGrants: ['a'], action: ACTION, caseVersion: 'v1' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'action_mismatch' });
    expect(vi.mocked(store.auditConsumeRefusal).mock.calls[0]!.slice(1)).toEqual(['dev_TEST', 'action_mismatch', { jtis: [], action: ACTION, caseVersion: 'v1' }]);
    expect(metrics.decisionGrantsRejectedTotal.labels).toHaveBeenCalledWith('consume', 'action_mismatch');

    vi.mocked(store.auditConsumeRefusal).mockRejectedValue(new Error('database unavailable'));
    seedAuth();
    const unaudited = await app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: authHeader(), payload: { decisionGrants: ['a'], action: ACTION, caseVersion: 'v1' } });
    expect(unaudited.statusCode).toBe(503);
    expect(unaudited.json()).toMatchObject({ code: 'DECISION_AUDIT_UNAVAILABLE', subReason: 'action_mismatch' });
  });

  describe('approver identity providers', () => {
    const url = '/v1/admin/developers/dev_TEST/decision-approver-idps';
    const payload = { issuer: 'https://idp.example.com', clientId: 'client-1', displayName: 'Workforce', actor: 'ops@example.com' };

    it('refuses the developer API key and a missing admin credential', async () => {
      seedAuth();
      expect((await app.inject({ method: 'POST', url, headers: authHeader(), payload })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
      expect(store.createApproverIdp).not.toHaveBeenCalled();
    });

    it('requires the operator identity and a valid issuer', async () => {
      const admin = { authorization: `Bearer ${TEST_ADMIN_API_KEY}` };
      for (const bad of [{ ...payload, actor: undefined }, { ...payload, issuer: 'not a url' }, { ...payload, issuer: 'https://idp.example.com/?x=1' }, { ...payload, clientId: '' }, { ...payload, acrValues: 'x' }]) {
        expect((await app.inject({ method: 'POST', url, headers: admin, payload: bad })).statusCode, JSON.stringify(bad)).toBe(400);
      }
      vi.mocked(store.createApproverIdp).mockResolvedValue({
        id: 'dapi_1', developer_id: 'dev_TEST', issuer: payload.issuer, client_id: payload.clientId, client_secret_encrypted: 'x',
        acr_values: [], require_verified_email: false, display_name: 'Workforce', status: 'active', created_by: payload.actor,
        created_at: new Date(), updated_at: new Date(),
      });
      const ok = await app.inject({ method: 'POST', url, headers: admin, payload: { ...payload, clientSecret: 'secret-value' } });
      expect(ok.statusCode).toBe(201);
      expect(ok.body).not.toContain('secret-value');
      expect(ok.json()).toMatchObject({ confidentialClient: true, redirectUri: 'https://grantex.dev/decisions/callback', createdBy: 'ops@example.com' });
    });
  });
});
