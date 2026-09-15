/**
 * Decision grants (PRD G-3) through the HTTP API against real Postgres.
 *
 * The route tests' SQL mock forwards to a real database here, so every query,
 * lock, unique constraint and transaction is the production one. Identity
 * provider ID tokens are signed with a local key; `verifyIdToken` checks them
 * with that key instead of fetching a JWKS.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { SignJWT, decodeJwt, generateKeyPair, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey, computeAuditHash } from '../src/lib/hash.js';
import { computeActionHash, type DecisionAction } from '../src/lib/decisions/action.js';
import { consumeDecisionGrants } from '../src/lib/decisions/store.js';
import { buildTestApp, sqlMock } from './helpers.js';

const idp = vi.hoisted(() => ({ publicKey: null as unknown, issuer: 'https://idp.example.com' }));

vi.mock('../src/lib/sso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/sso.js')>();
  return {
    ...actual,
    verifyIdToken: async (token: string, issuerUrl: string, clientId: string) => {
      const { payload } = await jwtVerify(token, idp.publicKey as CryptoKey, { issuer: issuerUrl, audience: clientId, algorithms: ['ES256'] });
      return payload;
    },
  };
});

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres decision-grant tests');
}
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('decision grants against real Postgres', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const developerId = `dev_dec_${suffix}`;
  const otherDeveloperId = `dev_dec_other_${suffix}`;
  const apiKey = `gx_test_decisions_${suffix}_key`;
  const otherApiKey = `gx_test_decisions_other_${suffix}_key`;
  const connectionId = `sso_dec_${suffix}`;
  const clientId = `client_${suffix}`;
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let idpPrivateKey: CryptoKey;
  let caseCounter = 0;
  const savedEnv = { ...process.env };

  const auth = (key = apiKey) => ({ authorization: `Bearer ${key}` });
  const now = () => Math.floor(Date.now() / 1000);
  const newCase = () => `case_${suffix}_${++caseCounter}`;
  const actionFor = (caseId: string, decision = 'approve'): DecisionAction => ({
    case_id: caseId,
    action: 'case_decision',
    decision,
    subject: 'gb:00000001',
  });

  async function idToken(sub: string, claims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ amr: ['pwd', 'hwk'], auth_time: now() - 30, email: `${sub}@example.com`, name: `Approver ${sub}`, ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'idp-key' })
      .setIssuer(idp.issuer)
      .setAudience(clientId)
      .setSubject(sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(idpPrivateKey);
  }

  async function approverSession(sub: string, claims: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/decisions/approver-sessions',
      headers: auth(),
      payload: { connectionId, idToken: await idToken(sub, claims) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ sessionToken: string }>().sessionToken;
  }

  async function createRequest(action: DecisionAction, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/decisions/requests',
      headers: auth(),
      payload: { action, connector: 'acme_kyb', caseVersion: 'v1', memoRef: 'memo:case/1', policyScoreRef: 'policy:uk/1.2.0', ...extra },
    });
    expect([200, 201], res.body).toContain(res.statusCode);
    return res.json<{ requestId: string; actionHash: string; approvalsRequired: number }>();
  }

  function approve(requestId: string, session: string, actionHash: string, dwellMs = 1_500) {
    return app.inject({
      method: 'POST',
      url: `/v1/decisions/requests/${requestId}/approvals`,
      headers: { ...auth(), 'grantex-approver-session': session },
      payload: { actionHash, dwellMs },
    });
  }

  function consume(decisionGrants: string[], action: DecisionAction, caseVersion = 'v1', key = apiKey) {
    return app.inject({
      method: 'POST',
      url: '/v1/decisions/consume',
      headers: auth(key),
      payload: { decisionGrants, action, caseVersion, agentId: 'ag_underwriter', grantId: 'grnt_underwriter' },
    });
  }

  async function approvedGrant(action: DecisionAction, sub = `alice_${suffix}`) {
    const request = await createRequest(action);
    const session = await approverSession(`${sub}_${randomUUID().slice(0, 6)}`);
    const res = await approve(request.requestId, session, request.actionHash);
    expect(res.statusCode, res.body).toBe(201);
    return { request, token: res.json<{ decisionGrant: string; jti: string }>().decisionGrant, jti: res.json<{ jti: string }>().jti };
  }

  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 12, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    await runMigrations(sql);
    const keys = await generateKeyPair('ES256');
    idp.publicKey = keys.publicKey;
    idpPrivateKey = keys.privateKey;
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
      (${developerId}, ${hashApiKey(apiKey)}, 'Decision Test'),
      (${otherDeveloperId}, ${hashApiKey(otherApiKey)}, 'Other Decision Test')`;
    await sql`INSERT INTO sso_connections (id, developer_id, name, protocol, status, issuer_url, client_id)
      VALUES (${connectionId}, ${developerId}, 'Approver IdP', 'oidc', 'active', ${idp.issuer}, ${clientId})`;
    process.env['DECISION_GRANTS_ENABLED'] = 'true';
    process.env['DECISION_STEP_UP_AMR'] = 'mfa,hwk';
    app = await buildTestApp();
  }, 120_000);

  beforeEach(() => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin(cb as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await app?.close();
    if (sql) {
      for (const dev of [developerId, otherDeveloperId]) {
        await sql`DELETE FROM decision_page_views WHERE request_id IN (SELECT id FROM decision_requests WHERE developer_id = ${dev})`.catch(() => undefined);
        await sql`DELETE FROM decision_page_tickets WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`UPDATE decision_grants SET first_jti = NULL WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_grants WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_requests WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_approver_sessions WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_cases WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM audit_entries WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM sso_connections WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM developers WHERE id = ${dev}`.catch(() => undefined);
      }
      await sql.end();
    }
  });

  it('migrates additively and idempotently', async () => {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_name LIKE 'decision_%' ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      'decision_approver_sessions', 'decision_cases', 'decision_grants', 'decision_page_tickets', 'decision_page_views', 'decision_requests',
    ]);
  });

  it('approving without step-up is refused at the API', async () => {
    const pwdOnly = await app.inject({
      method: 'POST', url: '/v1/decisions/approver-sessions', headers: auth(),
      payload: { connectionId, idToken: await idToken(`pwd_${suffix}`, { amr: ['pwd'] }) },
    });
    expect(pwdOnly.statusCode).toBe(403);
    expect(pwdOnly.json()).toMatchObject({ code: 'STEP_UP_REQUIRED', subReason: 'step_up_required' });

    const stale = await app.inject({
      method: 'POST', url: '/v1/decisions/approver-sessions', headers: auth(),
      payload: { connectionId, idToken: await idToken(`stale_${suffix}`, { auth_time: now() - 7200 }) },
    });
    expect(stale.json()).toMatchObject({ subReason: 'step_up_required' });

    const request = await createRequest(actionFor(newCase()));
    const noSession = await app.inject({
      method: 'POST', url: `/v1/decisions/requests/${request.requestId}/approvals`, headers: auth(),
      payload: { actionHash: request.actionHash, dwellMs: 1000 },
    });
    expect(noSession.statusCode).toBe(401);

    const wrongAudience = await app.inject({
      method: 'POST', url: '/v1/decisions/approver-sessions', headers: auth(),
      payload: { connectionId, idToken: await new SignJWT({ amr: ['hwk'], auth_time: now() }).setProtectedHeader({ alg: 'ES256' }).setIssuer(idp.issuer).setAudience('someone-else').setSubject('x').setIssuedAt().setExpirationTime('5m').sign(idpPrivateKey) },
    });
    expect(wrongAudience.statusCode).toBe(401);
    expect(wrongAudience.json()).toMatchObject({ code: 'APPROVER_AUTH_FAILED' });
  });

  it('an ID token is exchanged for one approver session only', async () => {
    const token = await idToken(`once_${suffix}`);
    const first = await app.inject({ method: 'POST', url: '/v1/decisions/approver-sessions', headers: auth(), payload: { connectionId, idToken: token } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/v1/decisions/approver-sessions', headers: auth(), payload: { connectionId, idToken: token } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ subReason: 'consumed' });
  });

  it('mints a decision+jwt and records approver identity, authentication method and dwell time in the audit chain', async () => {
    const action = actionFor(newCase());
    const request = await createRequest(action);
    const session = await approverSession(`jdoe_${suffix}`);
    const res = await approve(request.requestId, session, request.actionHash, 3_000);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ decisionGrant: string; jti: string; status: string }>();
    expect(body.status).toBe('approved');
    const claims = decodeJwt(body.decisionGrant);
    expect(claims).toMatchObject({
      sub: `user:jdoe_${suffix}`,
      aud: 'urn:grantex:decision',
      dev: developerId,
      idp: idp.issuer,
      approver_auth: 'sso+hwk+pwd',
      amr: ['hwk', 'pwd'],
      action,
      action_hash: computeActionHash(action),
      connector: 'acme_kyb',
      case_version: 'v1',
      dwell_ms: 3_000,
      decision_request: request.requestId,
      memo_ref: 'memo:case/1',
      policy_score_ref: 'policy:uk/1.2.0',
      jti: body.jti,
    });
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(86_400);

    const [entry] = await sql<{ metadata: Record<string, unknown>; principal_id: string }[]>`
      SELECT metadata, principal_id FROM audit_entries
      WHERE developer_id = ${developerId} AND action = 'decision.approved' AND metadata->>'jti' = ${body.jti}`;
    expect(entry!.principal_id).toBe(`user:jdoe_${suffix}`);
    expect(entry!.metadata).toMatchObject({
      approver: { sub: `user:jdoe_${suffix}`, idp: idp.issuer, email: `jdoe_${suffix}@example.com`, name: `Approver jdoe_${suffix}` },
      approver_auth: 'sso+hwk+pwd',
      amr: ['hwk', 'pwd'],
      dwell_ms: 3_000,
      dwell_source: 'reported',
      action,
      action_hash: computeActionHash(action),
    });

    // The chain still verifies: every entry's hash covers its predecessor.
    const chain = await sql<Record<string, unknown>[]>`
      SELECT * FROM audit_entries WHERE developer_id = ${developerId} ORDER BY timestamp, id`;
    let prev: string | null = null;
    for (const row of chain) {
      expect(row['previous_hash']).toBe(prev);
      expect(computeAuditHash({
        id: row['id'] as string, agentId: row['agent_id'] as string, agentDid: row['agent_did'] as string,
        grantId: row['grant_id'] as string, principalId: row['principal_id'] as string, developerId,
        action: row['action'] as string, metadata: row['metadata'] as Record<string, unknown>,
        timestamp: (row['timestamp'] as Date).toISOString(), prevHash: prev, status: row['status'] as string,
      })).toBe(row['hash']);
      prev = row['hash'] as string;
    }
    expect(chain.length).toBeGreaterThanOrEqual(2);

    const ok = await consume([body.decisionGrant], action);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ consumed: true, jtis: [body.jti], approvers: [{ sub: `user:jdoe_${suffix}`, approver_auth: 'sso+hwk+pwd', dwell_ms: 3_000 }] });
  });

  it('refuses an approval of an action other than the one displayed, and an unbounded dwell time', async () => {
    const request = await createRequest(actionFor(newCase()));
    const session = await approverSession(`display_${suffix}`);
    const mismatch = await approve(request.requestId, session, computeActionHash(actionFor('case_other')));
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ subReason: 'action_mismatch' });
    const tooLong = await approve(request.requestId, session, request.actionHash, 3_600_000);
    expect(tooLong.statusCode).toBe(400);
    const negative = await approve(request.requestId, session, request.actionHash, -1);
    expect(negative.statusCode).toBe(400);
  });

  it('replay with a different semantic action is denied (action_mismatch)', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    const res = await consume([token], { ...action, decision: 'decline' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'action_mismatch' });
    const amount = await consume([token], { ...action, amount: 1 });
    expect(amount.json()).toMatchObject({ subReason: 'action_mismatch' });
  });

  it('decision-grant replay across cases is denied (wrong_case)', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    const res = await consume([token], { ...action, case_id: newCase() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ subReason: 'wrong_case' });
  });

  it('replay of a consumed jti is denied (consumed) and the refusal is audited', async () => {
    const action = actionFor(newCase());
    const { token, jti } = await approvedGrant(action);
    expect((await consume([token], action)).statusCode).toBe(200);
    const replay = await consume([token], action);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ subReason: 'consumed' });
    const refused = await sql`
      SELECT status, metadata FROM audit_entries
      WHERE developer_id = ${developerId} AND action = 'decision.consume_refused' AND metadata->'jtis' ? ${jti}`;
    expect(refused[0]).toMatchObject({ status: 'blocked', metadata: { sub_reason: 'consumed' } });
  });

  it('an expired grant is denied (expired)', async () => {
    const action = actionFor(newCase());
    const { token, jti } = await approvedGrant(action);
    await sql`UPDATE decision_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE jti = ${jti}`;
    const res = await consume([token], action);
    expect(res.json()).toMatchObject({ subReason: 'expired' });
  });

  it('a case-changed grant is denied (case_changed)', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    const stale = await consume([token], action, 'v2');
    expect(stale.json()).toMatchObject({ subReason: 'case_changed' });

    const changed = await app.inject({ method: 'PUT', url: `/v1/decisions/cases/${action.case_id}`, headers: auth(), payload: { caseVersion: 'v2' } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ previousVersion: 'v1', caseVersion: 'v2', revokedGrants: 1 });
    const afterChange = await consume([token], action, 'v1');
    expect(afterChange.json()).toMatchObject({ subReason: 'case_changed' });
    const [audit] = await sql`SELECT metadata FROM audit_entries WHERE developer_id = ${developerId} AND action = 'decision.case_changed' AND metadata->>'case_id' = ${action.case_id}`;
    expect(audit).toBeDefined();

    const pendingAction = actionFor(newCase());
    const pending = await createRequest(pendingAction);
    const session = await approverSession(`pending_${suffix}`);
    await app.inject({ method: 'PUT', url: `/v1/decisions/cases/${pendingAction.case_id}`, headers: auth(), payload: { caseVersion: 'v9' } });
    const refused = await approve(pending.requestId, session, pending.actionHash);
    expect(refused.json()).toMatchObject({ subReason: 'case_changed' });
  });

  it('four-eyes: the same approver twice is refused, one grant is not enough, two approvers are consumed together', async () => {
    const action = actionFor(newCase(), 'decline');
    const request = await createRequest(action, { fourEyesOn: ['decline'] });
    expect(request.approvalsRequired).toBe(2);
    const alice = await approverSession(`fe_alice_${suffix}`);
    const first = await approve(request.requestId, alice, request.actionHash);
    expect(first.statusCode, first.body).toBe(201);
    const firstBody = first.json<{ decisionGrant: string; jti: string; status: string }>();
    expect(firstBody.status).toBe('pending');
    expect(decodeJwt(firstBody.decisionGrant)['four_eyes']).toEqual({ approvals_required: 2, position: 1 });

    const aliceAgain = await approverSession(`fe_alice_${suffix}`);
    const twice = await approve(request.requestId, aliceAgain, request.actionHash);
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ subReason: 'same_approver' });

    // Another IdP subject with the same email is the same person.
    const alias = await approverSession(`fe_alias_${suffix}`, { email: `FE_ALICE_${suffix}@example.com` });
    expect((await approve(request.requestId, alias, request.actionHash)).json()).toMatchObject({ subReason: 'same_approver' });

    const alone = await consume([firstBody.decisionGrant], action);
    expect(alone.json()).toMatchObject({ subReason: 'four_eyes_incomplete' });

    const bob = await approverSession(`fe_bob_${suffix}`);
    const second = await approve(request.requestId, bob, request.actionHash);
    expect(second.statusCode, second.body).toBe(201);
    const secondBody = second.json<{ decisionGrant: string; jti: string; status: string }>();
    expect(secondBody.status).toBe('approved');
    expect(decodeJwt(secondBody.decisionGrant)['four_eyes']).toEqual({
      approvals_required: 2, position: 2, first_jti: firstBody.jti, first_sub: `user:fe_alice_${suffix}`,
    });

    const doubled = await consume([firstBody.decisionGrant, firstBody.decisionGrant], action);
    expect(doubled.json()).toMatchObject({ subReason: 'same_approver' });

    const ok = await consume([firstBody.decisionGrant, secondBody.decisionGrant], action);
    expect(ok.statusCode, ok.body).toBe(200);
    const consumed = await sql`SELECT count(*)::int AS n FROM decision_grants WHERE request_id = ${request.requestId} AND consumed_at IS NOT NULL`;
    expect(consumed[0]!['n']).toBe(2);
    expect((await consume([secondBody.decisionGrant, firstBody.decisionGrant], action)).json()).toMatchObject({ subReason: 'consumed' });
  });

  it('two parallel consumes of one jti yield exactly one success', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () => consumeDecisionGrants(sql, { developerId, tokens: [token], action, caseVersion: 'v1' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ subReason: 'consumed' });

    const second = actionFor(newCase());
    const { token: token2 } = await approvedGrant(second);
    const responses = await Promise.all(Array.from({ length: 10 }, () => consume([token2], second)));
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409 && r.json<{ subReason: string }>().subReason === 'consumed')).toHaveLength(9);
  });

  it('parallel approvals cannot exceed the approvals a decision needs', async () => {
    const request = await createRequest(actionFor(newCase()));
    const sessions = await Promise.all([1, 2, 3, 4].map((n) => approverSession(`race_${n}_${suffix}`)));
    const responses = await Promise.all(sessions.map((s) => approve(request.requestId, s, request.actionHash)));
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    const grants = await sql`SELECT count(*)::int AS n FROM decision_grants WHERE request_id = ${request.requestId}`;
    expect(grants[0]!['n']).toBe(1);
  });

  it('is isolated per developer', async () => {
    const action = actionFor(newCase());
    const { token, request } = await approvedGrant(action);
    const foreign = await consume([token], action, 'v1', otherApiKey);
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json()).toMatchObject({ subReason: 'unknown_grant' });
    const get = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${request.requestId}`, headers: auth(otherApiKey) });
    expect(get.statusCode).toBe(404);
  });

  it('returns decision grants only while usable, and cancelling revokes them', async () => {
    const action = actionFor(newCase());
    const request = await createRequest(action);
    const pending = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${request.requestId}`, headers: auth() });
    expect(pending.json()).not.toHaveProperty('decisionGrants');
    const session = await approverSession(`get_${suffix}`);
    await approve(request.requestId, session, request.actionHash);
    const approved = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${request.requestId}`, headers: auth() });
    const tokens = approved.json<{ decisionGrants: string[] }>().decisionGrants;
    expect(tokens).toHaveLength(1);
    const cancel = await app.inject({ method: 'POST', url: `/v1/decisions/requests/${request.requestId}/cancel`, headers: auth() });
    expect(cancel.statusCode).toBe(200);
    expect((await consume(tokens, action)).json()).toMatchObject({ subReason: 'revoked' });
  });

  it('the approval page shows the exact action escaped, needs a session and CSRF token, and measures dwell time', async () => {
    const action: DecisionAction = { ...actionFor(newCase()), subject: 'gb:<script>alert(1)</script>' };
    const request = await createRequest(action, { memoRef: 'memo:"quoted" & <b>' });
    const session = await approverSession(`page_${suffix}`);

    const anonymous = await app.inject({ method: 'GET', url: `/decisions/${request.requestId}` });
    expect(anonymous.statusCode).toBe(401);

    const ticketRes = await app.inject({
      method: 'POST', url: `/v1/decisions/requests/${request.requestId}/page-tickets`,
      headers: { ...auth(), 'grantex-approver-session': session },
    });
    expect(ticketRes.statusCode, ticketRes.body).toBe(201);
    const url = new URL(ticketRes.json<{ url: string }>().url);
    const redirect = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(redirect.statusCode).toBe(303);
    const cookie = String(redirect.headers['set-cookie']).split(';')[0]!;
    expect(String(redirect.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    const reused = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(reused.statusCode).toBe(403);

    const page = await app.inject({ method: 'GET', url: `/decisions/${request.requestId}`, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).not.toContain('<script>');
    expect(page.body).toContain('gb:&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).toContain('memo:&quot;quoted&quot; &amp; &lt;b&gt;');
    expect(page.body).toContain(request.actionHash);
    const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(page.body)![1]!;

    const noCsrf = await app.inject({
      method: 'POST', url: `/decisions/${request.requestId}`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ view_id: field('view_id'), action_hash: request.actionHash, csrf_token: 'x' }).toString(),
    });
    expect(noCsrf.statusCode).toBe(403);
    const crossSite = await app.inject({
      method: 'POST', url: `/decisions/${request.requestId}`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'cross-site' },
      payload: new URLSearchParams({ view_id: field('view_id'), action_hash: request.actionHash, csrf_token: field('csrf_token') }).toString(),
    });
    expect(crossSite.statusCode).toBe(403);

    await sql`UPDATE decision_page_views SET rendered_at = NOW() - INTERVAL '42 seconds' WHERE id = ${field('view_id')}`;
    await sql`UPDATE decision_requests SET created_at = NOW() - INTERVAL '60 seconds' WHERE id = ${request.requestId}`;
    const submitted = await app.inject({
      method: 'POST', url: `/decisions/${request.requestId}`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      payload: new URLSearchParams({ view_id: field('view_id'), action_hash: request.actionHash, csrf_token: field('csrf_token') }).toString(),
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const [grant] = await sql<{ dwell_ms: number }[]>`SELECT dwell_ms FROM decision_grants WHERE request_id = ${request.requestId}`;
    expect(grant!.dwell_ms).toBeGreaterThanOrEqual(42_000);
    expect(grant!.dwell_ms).toBeLessThan(60_000);
    const [audit] = await sql`SELECT metadata FROM audit_entries WHERE developer_id = ${developerId} AND action = 'decision.approved' AND metadata->>'request_id' = ${request.requestId}`;
    expect(audit!['metadata']).toMatchObject({ dwell_source: 'page_view' });

    const resubmit = await app.inject({
      method: 'POST', url: `/decisions/${request.requestId}`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ view_id: field('view_id'), action_hash: request.actionHash, csrf_token: field('csrf_token') }).toString(),
    });
    expect(resubmit.statusCode).toBe(409);
  });
});
