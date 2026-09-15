/**
 * Decision-grant routes (PRD G-3) with the store mocked: the feature flag,
 * configuration failures, input validation and the refusal format. The
 * database behaviour is covered by decision-grants-postgres.integration.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth } from './helpers.js';
import { DecisionError } from '../src/lib/decisions/policy.js';
import { signApproverSession } from '../src/lib/decisions/token.js';

vi.mock('../src/lib/decisions/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/decisions/store.js')>();
  return {
    ...actual,
    approveDecisionRequest: vi.fn(),
    consumeDecisionGrants: vi.fn(),
    createDecisionRequest: vi.fn(),
    auditConsumeRefusal: vi.fn(),
  };
});

const store = await import('../src/lib/decisions/store.js');
const metrics = await import('../src/lib/metrics.js');

const ACTION = { case_id: 'case_8841', action: 'case_decision', decision: 'decline', subject: 'gb:00000001' };

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
    vi.mocked(store.approveDecisionRequest).mockReset();
    vi.mocked(store.consumeDecisionGrants).mockReset();
    vi.mocked(store.createDecisionRequest).mockReset();
  });

  it('is off by default (DECISION_GRANTS_ENABLED unset)', async () => {
    vi.stubEnv('DECISION_GRANTS_ENABLED', '');
    for (const [method, url] of [
      ['POST', '/v1/decisions/requests'],
      ['POST', '/v1/decisions/consume'],
      ['POST', '/v1/decisions/approver-sessions'],
    ] as const) {
      seedAuth();
      const res = await app.inject({ method, url, headers: authHeader(), payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'DECISION_GRANTS_DISABLED' });
    }
    const page = await app.inject({ method: 'GET', url: '/decisions/dreq_01K00000000000000000000000' });
    expect(page.statusCode).toBe(404);
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

  it('validates a decision request before touching the database', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ action: { ...ACTION, extra: 1 }, connector: 'acme_kyb', caseVersion: 'v1' }, /unknown field/],
      [{ action: ACTION, caseVersion: 'v1' }, /connector/],
      [{ action: ACTION, connector: 'acme_kyb' }, /caseVersion/],
      [{ action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', approvalsRequired: 3 }, /approvalsRequired/],
      [{ action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', fourEyesOn: ['decline'], approvalsRequired: 1 }, /contradicts/],
      [{ action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', expiresInSeconds: 86_401 }, /expiresInSeconds/],
      [{ action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', memoRef: 'a'.repeat(513) }, /memoRef/],
    ];
    for (const [payload, message] of cases) {
      seedAuth();
      const res = await app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: authHeader(), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(message);
    }
    expect(store.createDecisionRequest).not.toHaveBeenCalled();
  });

  it('derives four eyes from fourEyesOn for the requested decision', async () => {
    vi.mocked(store.createDecisionRequest).mockImplementation(async (_sql, input) => ({
      created: true,
      request: {
        id: 'dreq_01K00000000000000000000000', developer_id: 'dev_TEST', case_id: ACTION.case_id, case_version: 'v1',
        connector: 'acme_kyb', action: input.action, action_hash: 'sha256:x', approvals_required: input.approvalsRequired,
        memo_ref: null, policy_score_ref: null, agent_id: null, grant_id: null, status: 'pending',
        expires_at: new Date(Date.now() + 1000), created_at: new Date(), updated_at: new Date(),
      },
    }));
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: authHeader(),
      payload: { action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', fourEyesOn: ['decline'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ approvalsRequired: 2, created: true });
    expect(vi.mocked(store.createDecisionRequest).mock.calls[0]![1]).toMatchObject({ approvalsRequired: 2 });
  });

  it('requires a step-up approver session of the same developer to approve', async () => {
    seedAuth();
    const missing = await app.inject({
      method: 'POST', url: '/v1/decisions/requests/dreq_01K00000000000000000000000/approvals', headers: authHeader(),
      payload: { actionHash: 'sha256:x', dwellMs: 1000 },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'step_up_required' });

    const foreign = await signApproverSession('dsess_01K00000000000000000000000', 'dev_OTHER', Math.floor(Date.now() / 1000) + 60);
    seedAuth();
    const wrongDeveloper = await app.inject({
      method: 'POST', url: '/v1/decisions/requests/dreq_01K00000000000000000000000/approvals',
      headers: { ...authHeader(), 'grantex-approver-session': foreign },
      payload: { actionHash: 'sha256:x', dwellMs: 1000 },
    });
    expect(wrongDeveloper.statusCode).toBe(401);
    expect(store.approveDecisionRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['action_mismatch', 409, 'DECISION_INVALID'],
    ['same_approver', 409, 'DECISION_INVALID'],
    ['case_changed', 409, 'DECISION_INVALID'],
    ['expired', 410, 'DECISION_EXPIRED'],
    ['step_up_required', 403, 'STEP_UP_REQUIRED'],
  ] as const)('reports %s refusals with the sub-reason and counts them', async (subReason, status, code) => {
    const session = await signApproverSession('dsess_01K00000000000000000000000', 'dev_TEST', Math.floor(Date.now() / 1000) + 60);
    vi.mocked(store.approveDecisionRequest).mockRejectedValue(new DecisionError(subReason, status, 'refused'));
    vi.mocked(metrics.decisionGrantsRejectedTotal.labels).mockClear();
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/decisions/requests/dreq_01K00000000000000000000000/approvals',
      headers: { ...authHeader(), 'grantex-approver-session': session },
      payload: { actionHash: 'sha256:x', dwellMs: 1000 },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code, reason: 'decision_invalid', subReason });
    expect(metrics.decisionGrantsRejectedTotal.labels).toHaveBeenCalledWith('approve', subReason);
  });

  it('counts consumed grants and passes the expected action and case version to the store', async () => {
    vi.mocked(store.consumeDecisionGrants).mockResolvedValue({ requestId: 'dreq_1', jtis: ['dgnt_a', 'dgnt_b'], approvers: [], actionHash: 'sha256:x' });
    vi.mocked(metrics.decisionGrantsConsumedTotal.inc).mockClear();
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/decisions/consume', headers: authHeader(),
      payload: { decisionGrants: ['a', 'b'], action: ACTION, caseVersion: 'v1' },
    });
    expect(res.statusCode).toBe(200);
    expect(metrics.decisionGrantsConsumedTotal.inc).toHaveBeenCalledWith(2);
    expect(vi.mocked(store.consumeDecisionGrants).mock.calls[0]![1]).toMatchObject({ developerId: 'dev_TEST', action: ACTION, caseVersion: 'v1' });
  });

  it('refuses a malformed approver-session exchange', async () => {
    seedAuth();
    const res = await app.inject({ method: 'POST', url: '/v1/decisions/approver-sessions', headers: authHeader(), payload: { idToken: 'x' } });
    expect(res.statusCode).toBe(400);
  });
});
