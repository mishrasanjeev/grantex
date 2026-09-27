/**
 * Decision-grant routes (PRD G-3) with the store mocked: the feature flag,
 * configuration failures, input validation, the administrator-only identity
 * provider API, fail-closed auditing of refused consumptions and of decision
 * grant releases, and both states of DECISION_GRANT_AGENT_BINDING. Database
 * behaviour is covered by decision-grants-postgres.integration.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { buildTestApp, authHeader, seedAuth, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';
import { DecisionError } from '../src/lib/decisions/policy.js';
import { checkActiveGrantToken } from '../src/lib/active-grant-token.js';

vi.mock('../src/lib/decisions/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/decisions/store.js')>();
  return {
    ...actual,
    consumePresentedDecisionGrants: vi.fn(),
    consumePlatformDecisionRequest: vi.fn(),
    createDecisionRequest: vi.fn(),
    getDecisionRequest: vi.fn(),
    auditConsumeRefusal: vi.fn(),
    auditGrantRelease: vi.fn(),
    createApproverIdp: vi.fn(),
  };
});

vi.mock('../src/lib/active-grant-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/active-grant-token.js')>();
  return { ...actual, checkActiveGrantToken: vi.fn() };
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
    vi.mocked(store.consumePresentedDecisionGrants).mockReset();
    vi.mocked(store.consumePlatformDecisionRequest).mockReset();
    vi.mocked(store.createDecisionRequest).mockReset();
    vi.mocked(store.getDecisionRequest).mockReset();
    vi.mocked(store.auditConsumeRefusal).mockReset();
    vi.mocked(store.auditGrantRelease).mockReset();
    vi.mocked(store.createApproverIdp).mockReset();
    vi.mocked(checkActiveGrantToken).mockReset();
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
    expect(store.consumePresentedDecisionGrants).not.toHaveBeenCalled();
    expect(store.consumePlatformDecisionRequest).not.toHaveBeenCalled();
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
    vi.mocked(store.consumePresentedDecisionGrants).mockResolvedValue({ requestId: 'dreq_1', jtis: ['dgnt_a', 'dgnt_b'], approvers: [], actionHash: 'sha256:x' });
    vi.mocked(metrics.decisionGrantsConsumedTotal.inc).mockClear();
    seedAuth();
    const res = await app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: authHeader(), payload: { decisionGrants: ['a', 'b'], action: ACTION, caseVersion: 'v1' } });
    expect(res.statusCode).toBe(200);
    expect(metrics.decisionGrantsConsumedTotal.inc).toHaveBeenCalledWith(2);
    expect(vi.mocked(store.consumePresentedDecisionGrants).mock.calls[0]![1]).toMatchObject({ developerId: 'dev_TEST', action: ACTION, caseVersion: 'v1' });
  });

  it('records every refused consumption with the attempted action, and fails the request when that record cannot be written', async () => {
    vi.mocked(store.consumePresentedDecisionGrants).mockRejectedValue(new DecisionError('action_mismatch', 409, 'refused'));
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

  describe('decision grants and the requesting agent', () => {
    const REQUEST_ID = 'dreq_01K00000000000000000000000';
    const JWS = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

    /** An approved request for agent `ag_01` under `grnt_01`, with its one usable grant. */
    function approvedRequest() {
      const issuedAt = Math.floor(Date.now() / 1000);
      const request = {
        id: REQUEST_ID, developer_id: 'dev_TEST', case_id: ACTION.case_id, case_version: 'v1',
        connector: 'acme_kyb', action: ACTION, action_hash: `sha256:${'A'.repeat(43)}`, approvals_required: 1,
        memo_ref: null, memo_content: 'Registry active.', memo_hash: `sha256:${'M'.repeat(43)}`, policy_score_ref: null,
        policy_score: { tier: 'low' }, policy_score_hash: `sha256:${'P'.repeat(43)}`, agent_id: 'ag_01', grant_id: 'grnt_01',
        status: 'approved' as const, expires_at: new Date(Date.now() + 3_600_000), created_at: new Date(), updated_at: new Date(),
      };
      const claims = {
        iss: 'https://grantex.dev', aud: 'urn:grantex:decision', sub: 'user:ns:approver-a', jti: 'dgnt_01K00000000000000000000001',
        iat: issuedAt, exp: issuedAt + 3600, dev: 'dev_TEST', idp: 'https://idp.example.com', approver_auth: 'sso+hwk',
        amr: ['hwk'], auth_time: issuedAt, action: ACTION, action_hash: request.action_hash, connector: 'acme_kyb',
        case_version: 'v1', dwell_ms: 5000, dwell_source: 'server' as const, decision_request: request.id,
        memo_hash: request.memo_hash, policy_score_hash: request.policy_score_hash,
      };
      const grants = [{
        jti: claims.jti, developer_id: 'dev_TEST', request_id: request.id, session_id: 'dsess_1', approver_sub: claims.sub,
        approver_email_hash: null, approver_auth: 'sso+hwk', dwell_ms: 5000, dwell_source: 'server' as const, case_id: ACTION.case_id,
        case_version: 'v1', action_hash: request.action_hash, approval_position: 1, first_jti: null, claims,
        issued_at: new Date(issuedAt * 1000), expires_at: new Date((issuedAt + 3600) * 1000), consumed_at: null, revoked_at: null, revoked_reason: null,
      }];
      return { request, grants, claims };
    }

    /** A verified, live grant token of `agentDid` under `grantId`, as checkActiveGrantToken reports it. */
    function liveGrantToken(agentDid: string, grantId: string) {
      const iat = Math.floor(Date.now() / 1000);
      return { ok: true as const, claims: { sub: 'shopper-01', agt: agentDid, dev: 'dev_TEST', scp: ['tool:acme_kyb:write'], jti: 'tok_1', grnt: grantId, iat, exp: iat + 3600 } };
    }

    it('fails every decision endpoint closed (503) when DECISION_GRANT_AGENT_BINDING is neither true nor false', async () => {
      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'True');
      for (const [method, url] of [
        ['POST', '/v1/decisions/requests'], ['GET', `/v1/decisions/requests/${REQUEST_ID}`], ['POST', '/v1/decisions/consume'],
        ['POST', `/v1/decisions/requests/${REQUEST_ID}/grants`], ['POST', `/v1/decisions/requests/${REQUEST_ID}/consume`],
      ] as const) {
        seedAuth();
        const res = await app.inject({ method, url, headers: authHeader(), ...(method === 'POST' ? { payload: {} } : {}) });
        expect(res.statusCode, url).toBe(503);
        expect(res.json()).toMatchObject({ code: 'DECISION_CONFIG_INVALID' });
      }
      expect(store.consumePresentedDecisionGrants).not.toHaveBeenCalled();
      expect(store.consumePlatformDecisionRequest).not.toHaveBeenCalled();
      expect(store.getDecisionRequest).not.toHaveBeenCalled();
    });

    it('answers the decision grants to the developer API key when the binding is off, as before it existed', async () => {
      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'false');
      const { request, grants, claims } = approvedRequest();
      vi.mocked(store.getDecisionRequest).mockResolvedValue({ request, grants });
      seedAuth();
      const res = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${REQUEST_ID}`, headers: authHeader() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).not.toHaveProperty('decisionGrantsReady');
      const tokens = res.json<{ decisionGrants: string[] }>().decisionGrants;
      expect(tokens).toHaveLength(1);
      expect(decodeJwt(tokens[0]!)).toMatchObject({ jti: claims.jti, decision_request: REQUEST_ID });
    });

    it('never returns bearer decision grants from GET when the binding is on', async () => {
      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'true');
      const { request, grants, claims } = approvedRequest();
      vi.mocked(store.getDecisionRequest).mockResolvedValue({ request, grants });
      seedAuth();
      const res = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${REQUEST_ID}`, headers: authHeader() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'approved', decisionGrantsReady: true, approvals: [{ jti: claims.jti }] });
      expect(res.json()).not.toHaveProperty('decisionGrants');
      expect(res.body).not.toMatch(JWS);
    });

    it('releases decision grants only against a grant token, which it validates before touching the store', async () => {
      for (const binding of ['false', 'true']) {
        vi.stubEnv('DECISION_GRANT_AGENT_BINDING', binding);
        for (const payload of [{}, { grantToken: '' }, { grantToken: 7 }, { grantToken: 'x'.repeat(16_385) }]) {
          seedAuth();
          const res = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/grants`, headers: authHeader(), payload });
          expect(res.statusCode, JSON.stringify(payload).slice(0, 40)).toBe(400);
          expect(res.json<{ message: string }>().message).toMatch(/grantToken/);
        }
      }
      expect(store.getDecisionRequest).not.toHaveBeenCalled();
      expect(store.auditGrantRelease).not.toHaveBeenCalled();
    });

    it('records every hand-out and refusal of decision grants, and releases nothing when that record cannot be written', async () => {
      const { request, grants, claims } = approvedRequest();
      vi.mocked(store.getDecisionRequest).mockResolvedValue({ request, grants });
      vi.mocked(metrics.decisionGrantsRejectedTotal.labels).mockClear();

      // A token that is not live releases nothing, and the refusal says why.
      vi.mocked(checkActiveGrantToken).mockResolvedValueOnce({ ok: false, reason: 'revoked' });
      seedAuth();
      const revoked = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/grants`, headers: authHeader(), payload: { grantToken: 'token-of-a-revoked-grant' } });
      expect(revoked.statusCode).toBe(403);
      expect(revoked.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
      expect(vi.mocked(store.auditGrantRelease).mock.calls.at(-1)!.slice(1)).toEqual([
        'dev_TEST', request, {}, { released: false, subReason: 'wrong_agent', tokenCheck: 'revoked' },
      ]);
      expect(metrics.decisionGrantsRejectedTotal.labels).toHaveBeenCalledWith('release', 'wrong_agent');

      // Another agent's live token: refused and recorded with that agent.
      vi.mocked(checkActiveGrantToken).mockResolvedValueOnce(liveGrantToken('did:grantex:ag_02', 'grnt_02'));
      seedAuth();
      const other = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/grants`, headers: authHeader(), payload: { grantToken: 'token-of-another-agent' } });
      expect(other.statusCode).toBe(403);
      expect(vi.mocked(store.auditGrantRelease).mock.calls.at(-1)!.slice(3)).toEqual([
        { agentDid: 'did:grantex:ag_02', grantId: 'grnt_02' }, { released: false, subReason: 'wrong_agent' },
      ]);

      // The named agent: released and recorded with the jtis handed out.
      vi.mocked(checkActiveGrantToken).mockResolvedValueOnce(liveGrantToken('did:grantex:ag_01', 'grnt_01'));
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ did: 'did:grantex:ag_01' }] as never);
      const released = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/grants`, headers: authHeader(), payload: { grantToken: 'token-of-the-agent' } });
      expect(released.statusCode, released.body).toBe(200);
      expect(released.json()).toMatchObject({ decisionGrantsReady: true, decisionGrants: [expect.stringMatching(JWS)] });
      expect(vi.mocked(store.auditGrantRelease).mock.calls.at(-1)!.slice(3)).toEqual([
        { agentDid: 'did:grantex:ag_01', grantId: 'grnt_01' }, { released: true, jtis: [claims.jti], actionHash: request.action_hash },
      ]);

      // No record, no hand-out: the tokens never leave the service.
      vi.mocked(store.auditGrantRelease).mockRejectedValueOnce(new Error('database unavailable'));
      vi.mocked(checkActiveGrantToken).mockResolvedValueOnce(liveGrantToken('did:grantex:ag_01', 'grnt_01'));
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ did: 'did:grantex:ag_01' }] as never);
      const unaudited = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/grants`, headers: authHeader(), payload: { grantToken: 'token-of-the-agent' } });
      expect(unaudited.statusCode).toBe(503);
      expect(unaudited.json()).toMatchObject({ code: 'DECISION_AUDIT_UNAVAILABLE' });
      expect(unaudited.body).not.toMatch(JWS);
      expect(metrics.decisionGrantsRejectedTotal.labels).toHaveBeenCalledWith('release', 'audit_unavailable');

      // Nor does an unrecorded refusal go out as a plain refusal.
      vi.mocked(store.auditGrantRelease).mockRejectedValueOnce(new Error('database unavailable'));
      vi.mocked(checkActiveGrantToken).mockResolvedValueOnce({ ok: false, reason: 'expired' });
      seedAuth();
      const unrecorded = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/grants`, headers: authHeader(), payload: { grantToken: 'token-of-an-expired-grant' } });
      expect(unrecorded.statusCode).toBe(503);
      expect(unrecorded.json()).toMatchObject({ code: 'DECISION_AUDIT_UNAVAILABLE', subReason: 'wrong_agent' });
    });

    it('reads agentDid on consumption only when the binding is on, and compares only then', async () => {
      vi.mocked(store.consumePresentedDecisionGrants).mockResolvedValue({ requestId: REQUEST_ID, jtis: ['dgnt_a'], approvers: [], actionHash: 'sha256:x' });
      const consume = (payload: Record<string, unknown>) => {
        seedAuth();
        return app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: authHeader(), payload: { decisionGrants: ['a'], action: ACTION, caseVersion: 'v1', ...payload } });
      };

      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'true');
      for (const agentDid of ['did:grantex:ag_01', 'did:web:agents.example.com%3A8443:agents:ag_01']) {
        const res = await consume({ agentDid, grantId: 'grnt_01' });
        expect(res.statusCode, agentDid).toBe(200);
        expect(vi.mocked(store.consumePresentedDecisionGrants).mock.calls.at(-1)![1]).toMatchObject({ agentDid, grantId: 'grnt_01', bindAgent: true });
      }
      for (const payload of [{ agentDid: 'did grantex' }, { agentDid: 'ag_01' }, { agentDid: 'did:Grantex:ag_01' }, { agentDid: `did:grantex:${'a'.repeat(600)}` }, { agentDid: 7 }, { agentId: 'did:grantex:ag_01' }]) {
        const res = await consume(payload);
        expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      }

      // Off: agentDid is not read, however it looks, as before the binding; agentId is still a Grantex agent id.
      vi.mocked(store.consumePresentedDecisionGrants).mockClear();
      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', '');
      for (const agentDid of ['did:grantex:ag_01', 'not a DID', 7]) {
        const res = await consume({ agentDid, agentId: 'ag_01', grantId: 'grnt_01' });
        expect(res.statusCode, String(agentDid)).toBe(200);
        const input = vi.mocked(store.consumePresentedDecisionGrants).mock.calls.at(-1)![1];
        expect(input).toMatchObject({ agentId: 'ag_01', grantId: 'grnt_01', bindAgent: false });
        expect(input).not.toHaveProperty('agentDid');
      }
      expect((await consume({ agentId: 'did:grantex:ag_01' })).statusCode).toBe(400);
    });

    it('consumes the decision grants of a request by its id, on its own endpoint, in both states of the binding', async () => {
      vi.mocked(store.consumePlatformDecisionRequest).mockResolvedValue({ requestId: REQUEST_ID, jtis: ['dgnt_a'], approvers: [], actionHash: 'sha256:x' });
      for (const binding of ['false', 'true']) {
        vi.stubEnv('DECISION_GRANT_AGENT_BINDING', binding);
        seedAuth();
        const res = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/consume`, headers: authHeader(), payload: { action: ACTION, caseVersion: 'v1', decisionGrants: ['ignored'], agentId: 'ag_01' } });
        expect(res.statusCode, binding).toBe(200);
        const input = vi.mocked(store.consumePlatformDecisionRequest).mock.calls.at(-1)![1];
        expect(input).toEqual({ developerId: 'dev_TEST', requestId: REQUEST_ID, action: ACTION, caseVersion: 'v1' });
      }
      expect(store.consumePresentedDecisionGrants).not.toHaveBeenCalled();
      // The request id is not a member of the consume body: that endpoint only
      // consumes presented grants, which the store refuses when there are none.
      vi.mocked(store.consumePlatformDecisionRequest).mockClear();
      vi.mocked(store.consumePresentedDecisionGrants).mockRejectedValue(new DecisionError('malformed', 400, 'decisionGrants must be an array of one or two tokens'));
      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'false');
      seedAuth();
      const byBody = await app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: authHeader(), payload: { decisionRequest: REQUEST_ID, action: ACTION, caseVersion: 'v1' } });
      expect(byBody.statusCode).toBe(400);
      expect(byBody.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'malformed' });
      expect(store.consumePlatformDecisionRequest).not.toHaveBeenCalled();
      expect(vi.mocked(store.consumePresentedDecisionGrants).mock.calls.at(-1)![1]).not.toHaveProperty('requestId');
      expect(vi.mocked(store.auditConsumeRefusal).mock.calls.at(-1)![3]).not.toHaveProperty('requestId');
    });

    it('records a refused consumption by request id with that id, and fails the request when the record cannot be written', async () => {
      vi.mocked(store.consumePlatformDecisionRequest).mockRejectedValue(new DecisionError('wrong_agent', 403, 'refused'));
      vi.mocked(metrics.decisionGrantsRejectedTotal.labels).mockClear();
      seedAuth();
      const refused = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/consume`, headers: authHeader(), payload: { action: ACTION, caseVersion: 'v1' } });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
      expect(vi.mocked(store.auditConsumeRefusal).mock.calls.at(-1)!.slice(1)).toEqual(['dev_TEST', 'wrong_agent', { jtis: [], action: ACTION, caseVersion: 'v1', requestId: REQUEST_ID }]);
      expect(metrics.decisionGrantsRejectedTotal.labels).toHaveBeenCalledWith('consume', 'wrong_agent');
      expect(store.consumePresentedDecisionGrants).not.toHaveBeenCalled();

      vi.mocked(store.auditConsumeRefusal).mockRejectedValue(new Error('database unavailable'));
      seedAuth();
      const unaudited = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${REQUEST_ID}/consume`, headers: authHeader(), payload: { action: ACTION, caseVersion: 'v1' } });
      expect(unaudited.statusCode).toBe(503);
      expect(unaudited.json()).toMatchObject({ code: 'DECISION_AUDIT_UNAVAILABLE', subReason: 'wrong_agent' });
    });

    it('answers a repeated request with its approvals as they stand only when the binding is on', async () => {
      const { request, grants } = approvedRequest();
      vi.mocked(store.createDecisionRequest).mockResolvedValue({ request, created: false });
      vi.mocked(store.getDecisionRequest).mockResolvedValue({ request, grants });
      const repeat = () => {
        seedAuth();
        return app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: authHeader(), payload: { action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', agentId: 'ag_01', grantId: 'grnt_01', ...REVIEW } });
      };

      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'true');
      const bound = await repeat();
      expect(bound.statusCode, bound.body).toBe(200);
      expect(bound.json()).toMatchObject({ created: false, approvalsReceived: 1, decisionGrantsReady: true, approvals: [{ jti: grants[0]!.jti }] });
      expect(bound.body).not.toMatch(JWS);
      expect(vi.mocked(store.createDecisionRequest).mock.calls.at(-1)![1]).toMatchObject({ agentId: 'ag_01', grantId: 'grnt_01', bindAgent: true });

      vi.mocked(store.getDecisionRequest).mockClear();
      vi.stubEnv('DECISION_GRANT_AGENT_BINDING', 'false');
      const unbound = await repeat();
      expect(unbound.statusCode).toBe(200);
      expect(unbound.json()).toMatchObject({ created: false, approvalsReceived: 0 });
      expect(unbound.json()).not.toHaveProperty('decisionGrantsReady');
      expect(vi.mocked(store.createDecisionRequest).mock.calls.at(-1)![1]).toMatchObject({ bindAgent: false });
      expect(store.getDecisionRequest).not.toHaveBeenCalled();
      // A request names its agent by Grantex agent id, in both states.
      for (const binding of ['false', 'true']) {
        vi.stubEnv('DECISION_GRANT_AGENT_BINDING', binding);
        seedAuth();
        const did = await app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: authHeader(), payload: { action: ACTION, connector: 'acme_kyb', caseVersion: 'v1', agentId: 'did:grantex:ag_01', ...REVIEW } });
        expect(did.statusCode, binding).toBe(400);
      }
    });
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
