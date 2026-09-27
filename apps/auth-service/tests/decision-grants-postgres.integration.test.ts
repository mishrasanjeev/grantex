/**
 * Decision grants (PRD G-3) end to end against real Postgres: the service
 * administrator allow-lists an identity provider, a platform creates a
 * decision request with its API key, the approver signs in with the browser
 * OIDC flow and approves on the approval page, and the platform consumes the
 * grant. The SQL mock forwards to a real database, so every query, lock,
 * unique constraint and transaction is the production one. The identity
 * provider is simulated behind the outbound-fetch test hook: discovery, JWKS
 * and a token endpoint that checks the PKCE verifier.
 *
 * Every test outside the blocks at the end runs with
 * DECISION_GRANT_AGENT_BINDING unset (the default), so it shows the endpoints
 * answering as they did before decision grants were bound to the requesting
 * agent. The blocks at the end cover each state of that setting.
 */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runMigrations } from '../src/db/migrate.js';
import { hashApiKey, computeAuditHash } from '../src/lib/hash.js';
import { setSafeFetchForTests } from '../src/lib/url-security.js';
import { clearApproverIdpCaches } from '../src/lib/decisions/approver-oidc.js';
import { computeActionHash, type DecisionAction } from '../src/lib/decisions/action.js';
import { consumePresentedDecisionGrants, createApproverSession, type ApproverIdpRow } from '../src/lib/decisions/store.js';
import { signDecisionGrant, type DecisionGrantClaims } from '../src/lib/decisions/token.js';
import { signGrantToken } from '../src/lib/crypto.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from './helpers.js';
import { createTestDatabase } from './helpers/database.js';

// This file runs against a database of its own. Sharing one database across
// the Postgres integration files let `CREATE INDEX CONCURRENTLY` in one file
// deadlock against another file's migration run (FINDINGS G-24).
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres decision-grant tests');
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;

const ORIGIN = 'https://grantex.dev';
const ISSUER = 'https://idp.example.com';
const OTHER_ISSUER = 'https://idp-two.example.com';

interface PendingCode { sub: string; claims: Record<string, unknown>; nonce: string; challenge: string; clientId: string; issuer: string }

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('decision-grants');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await dropTestDatabase?.();
}, 60_000);

describePostgres('decision grants against real Postgres', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const developerId = `dev_dec_${suffix}`;
  const otherDeveloperId = `dev_dec_other_${suffix}`;
  const apiKey = `gx_test_decisions_${suffix}_key`;
  const otherApiKey = `gx_test_decisions_other_${suffix}_key`;
  const clientId = `client_${suffix}`;
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let signingKey: CryptoKey;
  let jwk: Record<string, unknown>;
  let idpId = '';
  let otherIdpId = '';
  let caseCounter = 0;
  const codes = new Map<string, PendingCode>();
  const idpBehaviour = { discoveryIssuer: undefined as string | undefined, nonceOverride: undefined as string | undefined, azp: undefined as string | undefined };
  const savedEnv = { ...process.env };

  const auth = (key = apiKey) => ({ authorization: `Bearer ${key}` });
  const admin = () => ({ authorization: `Bearer ${TEST_ADMIN_API_KEY}` });
  const now = () => Math.floor(Date.now() / 1000);
  const newCase = () => `case_${suffix}_${++caseCounter}`;
  const actionFor = (caseId: string, decision = 'approve'): DecisionAction => ({ case_id: caseId, action: 'case_decision', decision, subject: 'gb:00000001' });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const SESSION = '__Host-grantex_decision_session';
  const LOGIN = '__Host-grantex_decision_login';
  const cookieValue = (setCookie: string | string[] | undefined, name: string): string | undefined => {
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const pair = c.split(';')[0]!;
      const index = pair.indexOf('=');
      if (pair.slice(0, index) === name && index < pair.length - 1) return pair.slice(index + 1);
    }
    return undefined;
  };

  async function addIdp(issuer: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: 'POST', url: `/v1/admin/developers/${developerId}/decision-approver-idps`, headers: admin(),
      payload: { issuer, clientId, displayName: `Workforce ${issuer}`, actor: 'ops@example.com', ...extra },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function createRequest(action: DecisionAction, extra: Record<string, unknown> = {}, key = apiKey) {
    const res = await app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: auth(key),
      payload: {
        action, connector: 'acme_kyb', caseVersion: 'v1',
        memo: { ref: 'memo:case/1', content: 'Registry active. Owners reconcile.' },
        policyScore: { ref: 'policy:uk/1.2.0', content: { tier: 'low', score: 12, reasons: [] } },
        ...extra,
      },
    });
    expect([200, 201], res.body).toContain(res.statusCode);
    return res.json<{ requestId: string; actionHash: string; approvalsRequired: number; memoHash: string; policyScoreHash: string }>();
  }

  /** Browser sign-in; returns the session cookie header value when it succeeded. */
  async function signIn(requestId: string, sub: string, claims: Record<string, unknown> = {}, idp = idpId): Promise<{ cookie?: string; status: number; body: string }> {
    const start = await app.inject({ method: 'GET', url: `/decisions/login?request=${requestId}&idp=${idp}` });
    if (start.statusCode !== 302) return { status: start.statusCode, body: start.body };
    const binding = cookieValue(start.headers['set-cookie'], LOGIN)!;
    const location = new URL(String(start.headers['location']));
    const code = randomUUID();
    codes.set(code, {
      sub,
      claims: { amr: ['pwd', 'hwk'], auth_time: now() - 30, email: `${sub}@example.com`, email_verified: true, name: `Approver ${sub}`, ...claims },
      nonce: location.searchParams.get('nonce')!,
      challenge: location.searchParams.get('code_challenge')!,
      clientId: location.searchParams.get('client_id')!,
      issuer: `${location.protocol}//${location.host}`,
    });
    const back = await app.inject({
      method: 'GET',
      url: `/decisions/callback?code=${code}&state=${location.searchParams.get('state')}`,
      headers: { cookie: `${LOGIN}=${binding}` },
    });
    const secret = cookieValue(back.headers['set-cookie'], SESSION);
    return { status: back.statusCode, body: back.body, ...(secret ? { cookie: `${SESSION}=${secret}` } : {}) };
  }

  async function openPage(requestId: string, cookie: string) {
    const page = await app.inject({ method: 'GET', url: `/decisions/${requestId}`, headers: { cookie } });
    const field = (name: string) => new RegExp(`name="${name}" value="([^"]+)"`).exec(page.body)?.[1];
    return { page, viewId: field('view_id'), csrf: field('csrf_token'), actionHash: field('action_hash') };
  }

  async function approve(requestId: string, cookie: string, options: { backdateMs?: number; headers?: Record<string, string>; override?: Record<string, string> } = {}) {
    const { viewId, csrf, actionHash, page } = await openPage(requestId, cookie);
    if (!viewId) return { statusCode: page.statusCode, body: page.body };
    await sql`UPDATE decision_page_views SET rendered_at = rendered_at - make_interval(secs => ${(options.backdateMs ?? 5_000) / 1000}) WHERE id = ${viewId}`;
    const headers: Record<string, string> = { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(options.headers ?? {}) };
    for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];
    const res = await app.inject({
      method: 'POST', url: `/decisions/${requestId}`, headers,
      payload: new URLSearchParams({ view_id: viewId, csrf_token: csrf!, action_hash: actionHash!, ...(options.override ?? {}) }).toString(),
    });
    return { statusCode: res.statusCode, body: res.body };
  }

  async function grantsFor(requestId: string): Promise<string[]> {
    const res = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${requestId}`, headers: auth() });
    return res.json<{ decisionGrants?: string[] }>().decisionGrants ?? [];
  }

  async function approvedGrant(action: DecisionAction) {
    const request = await createRequest(action);
    const session = await signIn(request.requestId, `alice_${randomUUID().slice(0, 8)}`);
    const res = await approve(request.requestId, session.cookie!);
    expect(res.statusCode, res.body).toBe(200);
    const [token] = await grantsFor(request.requestId);
    return { request, token: token!, jti: decodeJwt(token!).jti as string };
  }

  function consume(decisionGrants: string[], action: DecisionAction, caseVersion = 'v1', key = apiKey) {
    return app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: auth(key), payload: { decisionGrants, action, caseVersion, agentId: 'ag_underwriter', grantId: 'grnt_underwriter' } });
  }

  beforeAll(async () => {
    sql = postgres(databaseUrl!, { max: 12, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    const pair = await generateKeyPair('ES256');
    signingKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'idp-1', alg: 'ES256', use: 'sig' };
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES
      (${developerId}, ${hashApiKey(apiKey)}, 'Decision Test'),
      (${otherDeveloperId}, ${hashApiKey(otherApiKey)}, 'Other Decision Test')`;
    process.env['DECISION_GRANTS_ENABLED'] = 'true';
    delete process.env['DECISION_GRANT_AGENT_BINDING'];
    process.env['DECISION_STEP_UP_AMR'] = 'mfa,hwk';
    process.env['DECISION_MIN_DWELL_MS'] = '2000';

    setSafeFetchForTests(async (url, init) => {
      const u = new URL(url);
      const issuer = `${u.protocol}//${u.host}`;
      if (u.pathname === '/.well-known/openid-configuration') {
        return json({ issuer: idpBehaviour.discoveryIssuer ?? issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      }
      if (u.pathname === '/jwks') return json({ keys: [jwk] });
      if (u.pathname === '/token') {
        const form = new URLSearchParams(String(init.body));
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (!pending) return json({ error: 'invalid_grant' }, 400);
        if (createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== pending.challenge) return json({ error: 'invalid_grant' }, 400);
        const claims = { ...pending.claims };
        for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
        const idToken = await new SignJWT({ nonce: idpBehaviour.nonceOverride ?? pending.nonce, ...(idpBehaviour.azp ? { azp: idpBehaviour.azp } : {}), ...claims })
          .setProtectedHeader({ alg: 'ES256', kid: 'idp-1' })
          .setIssuer(pending.issuer).setAudience(pending.clientId).setSubject(pending.sub)
          .setIssuedAt().setExpirationTime('5m')
          .sign(signingKey);
        return json({ id_token: idToken, token_type: 'Bearer', access_token: 'opaque' });
      }
      return json({}, 404);
    });

    app = await buildTestApp();
  }, 120_000);

  beforeEach(async () => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin(cb as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
    idpBehaviour.discoveryIssuer = undefined;
    idpBehaviour.nonceOverride = undefined;
    idpBehaviour.azp = undefined;
    clearApproverIdpCaches();
    if (!idpId) {
      idpId = await addIdp(ISSUER);
      otherIdpId = await addIdp(OTHER_ISSUER, { requireVerifiedEmail: true });
    }
  });

  afterAll(async () => {
    setSafeFetchForTests(null);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await app?.close();
    if (sql) {
      for (const dev of [developerId, otherDeveloperId]) {
        await sql`DELETE FROM decision_page_views WHERE request_id IN (SELECT id FROM decision_requests WHERE developer_id = ${dev})`.catch(() => undefined);
        await sql`UPDATE decision_grants SET first_jti = NULL WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_grants WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_login_states WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_approver_sessions WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_requests WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_approver_idps WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM decision_cases WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM sso_connections WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM grant_tokens WHERE grant_id IN (SELECT id FROM grants WHERE developer_id = ${dev})`.catch(() => undefined);
        await sql`DELETE FROM grants WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM agents WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM audit_entries WHERE developer_id = ${dev}`.catch(() => undefined);
        await sql`DELETE FROM developers WHERE id = ${dev}`.catch(() => undefined);
      }
      await sql.end();
    }
  });

  // The second `runMigrations` this used to make is now a no-op — with the
  // ledger a file is applied at most once per database — so it proved nothing
  // about idempotency and has been replaced by an assertion of what the runner
  // now guarantees. Re-executing every file against a database already at head
  // is covered by the transition case in
  // tests/migrate-ledger-postgres.integration.test.ts.
  it('migrates additively, and a repeat start applies nothing', async () => {
    const repeat = await runMigrations(sql);
    expect(repeat.applied).toEqual([]);
    expect(repeat.skipped).toBeGreaterThan(50);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_name LIKE 'decision_%' AND table_schema = current_schema()
       ORDER BY table_name`;
    expect(tables.map((t) => t.table_name)).toEqual([
      'decision_approver_idps', 'decision_approver_sessions', 'decision_cases', 'decision_grants', 'decision_login_states', 'decision_page_views', 'decision_requests',
    ]);
  });

  describe('the developer API key cannot approve', () => {
    it('has no API to create approver sessions, approve or configure approver identity providers', async () => {
      const request = await createRequest(actionFor(newCase()));
      for (const [method, url] of [
        ['POST', '/v1/decisions/approver-sessions'],
        ['POST', `/v1/decisions/requests/${request.requestId}/approvals`],
        ['POST', `/v1/decisions/requests/${request.requestId}/page-tickets`],
      ] as const) {
        const res = await app.inject({ method, url, headers: auth(), payload: {} });
        expect(res.statusCode, url).toBe(404);
      }
      const asDeveloper = await app.inject({
        method: 'POST', url: `/v1/admin/developers/${developerId}/decision-approver-idps`, headers: auth(),
        payload: { issuer: 'https://idp.attacker.example.com', clientId: 'x', displayName: 'x', actor: 'x' },
      });
      expect(asDeveloper.statusCode).toBe(401);
    });

    it('an SSO connection the developer registers is not an approver identity provider', async () => {
      const request = await createRequest(actionFor(newCase()));
      await sql`INSERT INTO sso_connections (id, developer_id, name, protocol, status, issuer_url, client_id)
        VALUES (${`sso_dec_${suffix}`}, ${developerId}, 'Platform IdP', 'oidc', 'active', 'https://idp.attacker.example.com', 'x')
        ON CONFLICT DO NOTHING`;
      const page = await app.inject({ method: 'GET', url: `/decisions/${request.requestId}` });
      expect(page.statusCode).toBe(401);
      expect(page.body).not.toContain('idp.attacker.example.com');
      expect(page.body).toContain(`idp=${idpId}`);
      const login = await app.inject({ method: 'GET', url: `/decisions/login?request=${request.requestId}&idp=sso_dec_${suffix}` });
      expect(login.statusCode).toBe(400);
    });

    it('records approver identity provider changes with the operator in the audit chain', async () => {
      const [entry] = await sql<{ metadata: Record<string, unknown>; principal_id: string }[]>`
        SELECT metadata, principal_id FROM audit_entries WHERE developer_id = ${developerId} AND action = 'decision.approver_idp_added' AND metadata->>'idp_id' = ${idpId}`;
      expect(entry).toMatchObject({ principal_id: 'admin:ops@example.com', metadata: { issuer: ISSUER, client_id: clientId, actor: 'ops@example.com' } });
    });
  });

  describe('browser sign-in', () => {
    it('sets __Host- HttpOnly Secure SameSite=Lax cookies and never returns the session secret in a body', async () => {
      const request = await createRequest(actionFor(newCase()));
      const start = await app.inject({ method: 'GET', url: `/decisions/login?request=${request.requestId}&idp=${idpId}` });
      const location = new URL(String(start.headers['location']));
      expect(location.origin).toBe(ISSUER);
      expect(Object.fromEntries(location.searchParams)).toMatchObject({ response_type: 'code', client_id: clientId, code_challenge_method: 'S256', redirect_uri: `${ORIGIN}/decisions/callback`, max_age: '3600' });
      expect(String(start.headers['set-cookie'])).toMatch(/^__Host-grantex_decision_login=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
      const session = await signIn(request.requestId, `cookie_${suffix}`);
      expect(session.status).toBe(303);
      expect(session.cookie).toBeDefined();
      expect(session.body).toBe('');
    });

    it('approving without step-up is impossible (password-only, stale or unknown authentication time)', async () => {
      const request = await createRequest(actionFor(newCase()));
      const pwd = await signIn(request.requestId, `pwd_${suffix}`, { amr: ['pwd'] });
      expect(pwd.status).toBe(403);
      expect(pwd.cookie).toBeUndefined();
      expect((await signIn(request.requestId, `stale_${suffix}`, { auth_time: now() - 7200 })).status).toBe(403);
      expect((await signIn(request.requestId, `noauth_${suffix}`, { auth_time: undefined })).status).toBe(403);
    });

    it('refuses a wrong nonce, a foreign azp, a discovery issuer mismatch, another browser and a reused state', async () => {
      const request = await createRequest(actionFor(newCase()));
      idpBehaviour.nonceOverride = 'another-nonce';
      expect((await signIn(request.requestId, `nonce_${suffix}`)).status).toBe(401);
      idpBehaviour.nonceOverride = undefined;
      idpBehaviour.azp = 'some-other-client';
      expect((await signIn(request.requestId, `azp_${suffix}`)).status).toBe(401);
      idpBehaviour.azp = undefined;
      idpBehaviour.discoveryIssuer = 'https://idp.attacker.example.com';
      clearApproverIdpCaches();
      expect((await signIn(request.requestId, `disc_${suffix}`)).status).toBe(502);
      idpBehaviour.discoveryIssuer = undefined;
      clearApproverIdpCaches();

      const start = await app.inject({ method: 'GET', url: `/decisions/login?request=${request.requestId}&idp=${idpId}` });
      const binding = cookieValue(start.headers['set-cookie'], LOGIN)!;
      const location = new URL(String(start.headers['location']));
      const state = location.searchParams.get('state')!;
      const code = randomUUID();
      codes.set(code, { sub: `bind_${suffix}`, claims: { amr: ['hwk'], auth_time: now() }, nonce: location.searchParams.get('nonce')!, challenge: location.searchParams.get('code_challenge')!, clientId, issuer: ISSUER });
      const otherBrowser = await app.inject({ method: 'GET', url: `/decisions/callback?code=${code}&state=${state}` });
      expect(otherBrowser.statusCode).toBe(400);
      const withCookie = await app.inject({ method: 'GET', url: `/decisions/callback?code=${code}&state=${state}`, headers: { cookie: `${LOGIN}=${binding}` } });
      expect(withCookie.statusCode).toBe(303);
      const replay = await app.inject({ method: 'GET', url: `/decisions/callback?code=${code}&state=${state}`, headers: { cookie: `${LOGIN}=${binding}` } });
      expect(replay.statusCode).toBe(400);
    });

    it('accepts an identity-provider nonce once per issuer and subject', async () => {
      const [idp] = await sql<ApproverIdpRow[]>`SELECT * FROM decision_approver_idps WHERE id = ${idpId}`;
      const input = { developerId, idp: idp!, claims: { subject: `nonce_once_${suffix}`, amr: ['hwk'], authTime: now() }, nonce: `n_${suffix}`, stepUp: { acrValues: [], amrValues: ['hwk'], maxAgeSeconds: 3600, idTokenMaxAgeSeconds: 600 }, nowSeconds: now() };
      await createApproverSession(sql, input);
      await expect(createApproverSession(sql, input)).rejects.toMatchObject({ subReason: 'consumed' });
    });

    it('requires a verified email when the identity provider is configured to', async () => {
      const request = await createRequest(actionFor(newCase()));
      expect((await signIn(request.requestId, `unverified_${suffix}`, { email_verified: false }, otherIdpId)).status).toBe(403);
      expect((await signIn(request.requestId, `verified_${suffix}`, {}, otherIdpId)).status).toBe(303);
    });

    it('stores no approver email or name in plaintext', async () => {
      const request = await createRequest(actionFor(newCase()));
      const sub = `private_${suffix}`;
      await signIn(request.requestId, sub);
      const rows = await sql`SELECT * FROM decision_approver_sessions WHERE idp_subject = ${sub}`;
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(`${sub}@example.com`);
      expect(dump).not.toContain(`Approver ${sub}`);
      expect(rows[0]!['email_hash']).toMatch(/^hmac-sha256:/);
      const audit = await sql`SELECT metadata FROM audit_entries WHERE developer_id = ${developerId} AND action = 'decision.approver_signed_in' AND principal_id LIKE ${`%:${sub}`}`;
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain('@example.com');
    });
  });

  describe('approval page', () => {
    it('shows the memo, policy score and exact action escaped, with no script and no framing', async () => {
      const action: DecisionAction = { ...actionFor(newCase()), subject: 'gb:<script>alert(1)</script>' };
      const request = await createRequest(action, { memo: { content: 'Owner "A" & <b>B</b>' }, policyScore: { content: { tier: '<i>low</i>' } } });
      const session = await signIn(request.requestId, `page_${suffix}`);
      const { page } = await openPage(request.requestId, session.cookie!);
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      // A browser sends Origin: null on form posts from a no-referrer page, which the approval refuses.
      expect(page.headers['referrer-policy']).toBe('same-origin');
      expect(page.body).not.toContain('<script>');
      expect(page.body).toContain('gb:&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(page.body).toContain('Owner &quot;A&quot; &amp; &lt;b&gt;B&lt;/b&gt;');
      expect(page.body).toContain('&lt;i&gt;low&lt;/i&gt;');
      expect(page.body).toContain(request.actionHash);
      expect(page.body).toContain(request.memoHash);
      expect(page.body).toContain(request.policyScoreHash);
    });

    it('refuses a submission without Origin or Sec-Fetch-Site, from another site, with a bad CSRF token or of another action hash', async () => {
      const request = await createRequest(actionFor(newCase()));
      const session = await signIn(request.requestId, `csrf_${suffix}`);
      expect((await approve(request.requestId, session.cookie!, { headers: { origin: '', 'sec-fetch-site': '' } })).statusCode).toBe(403);
      expect((await approve(request.requestId, session.cookie!, { headers: { origin: '' } })).statusCode).toBe(403);
      expect((await approve(request.requestId, session.cookie!, { headers: { 'sec-fetch-site': '' } })).statusCode).toBe(403);
      expect((await approve(request.requestId, session.cookie!, { headers: { 'sec-fetch-site': 'same-site' } })).statusCode).toBe(403);
      expect((await approve(request.requestId, session.cookie!, { headers: { 'sec-fetch-site': 'cross-site' } })).statusCode).toBe(403);
      expect((await approve(request.requestId, session.cookie!, { headers: { origin: 'https://console.example.com' } })).statusCode).toBe(403);
      expect((await approve(request.requestId, session.cookie!, { override: { csrf_token: 'x' } })).statusCode).toBe(403);
      const mismatch = await approve(request.requestId, session.cookie!, { override: { action_hash: computeActionHash(actionFor('case_other')) } });
      expect(mismatch.statusCode).toBe(409);
      expect((await sql`SELECT count(*)::int AS n FROM decision_grants WHERE request_id = ${request.requestId}`)[0]!['n']).toBe(0);
    });

    it('measures dwell time on the server and refuses an approval faster than the minimum', async () => {
      const request = await createRequest(actionFor(newCase()));
      const session = await signIn(request.requestId, `dwell_${suffix}`);
      const fast = await approve(request.requestId, session.cookie!, { backdateMs: 0 });
      expect(fast.statusCode).toBe(400);
      expect(fast.body).toContain('at least 2000 ms');
      const ok = await approve(request.requestId, session.cookie!, { backdateMs: 42_000 });
      expect(ok.statusCode, ok.body).toBe(200);
      const [grant] = await sql<{ dwell_ms: number; dwell_source: string }[]>`SELECT dwell_ms, dwell_source FROM decision_grants WHERE request_id = ${request.requestId}`;
      expect(grant!.dwell_source).toBe('server');
      expect(grant!.dwell_ms).toBeGreaterThanOrEqual(42_000);
      expect(grant!.dwell_ms).toBeLessThan(60_000);
    });

    it("a session of one developer does not open another developer's decision", async () => {
      const mine = await createRequest(actionFor(newCase()));
      const session = await signIn(mine.requestId, `iso_${suffix}`);
      const theirs = await createRequest(actionFor(newCase()), {}, otherApiKey);
      const page = await app.inject({ method: 'GET', url: `/decisions/${theirs.requestId}`, headers: { cookie: session.cookie! } });
      expect(page.statusCode).not.toBe(200);
      expect(page.body).not.toContain('Registry active');
    });
  });

  it('mints a decision+jwt and records approver identity, authentication method and dwell time in the audit chain', async () => {
    const action = actionFor(newCase());
    const request = await createRequest(action);
    const sub = `jdoe_${suffix}`;
    const session = await signIn(request.requestId, sub);
    const res = await approve(request.requestId, session.cookie!, { backdateMs: 61_250 });
    expect(res.statusCode, res.body).toBe(200);
    const [token] = await grantsFor(request.requestId);
    const claims = decodeJwt(token!);
    const namespace = createHash('sha256').update(ISSUER).digest('base64url').slice(0, 22);
    expect(claims).toMatchObject({
      sub: `user:${namespace}:${sub}`, aud: 'urn:grantex:decision', dev: developerId, idp: ISSUER,
      approver_auth: 'sso+hwk+pwd', amr: ['hwk', 'pwd'], action, action_hash: computeActionHash(action),
      connector: 'acme_kyb', case_version: 'v1', dwell_source: 'server', decision_request: request.requestId,
      memo_hash: request.memoHash, policy_score_hash: request.policyScoreHash, memo_ref: 'memo:case/1',
    });
    expect(claims['dwell_ms']).toBeGreaterThanOrEqual(61_250);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(86_400);

    const [entry] = await sql<{ metadata: Record<string, unknown>; principal_id: string }[]>`
      SELECT metadata, principal_id FROM audit_entries WHERE developer_id = ${developerId} AND action = 'decision.approved' AND metadata->>'jti' = ${claims.jti as string}`;
    expect(entry!.principal_id).toBe(`user:${namespace}:${sub}`);
    expect(entry!.metadata).toMatchObject({
      approver: { sub: `user:${namespace}:${sub}`, idp: ISSUER, idp_id: idpId },
      approver_auth: 'sso+hwk+pwd', amr: ['hwk', 'pwd'], dwell_source: 'server', action, action_hash: computeActionHash(action),
    });

    const chain = await sql<Record<string, unknown>[]>`SELECT * FROM audit_entries WHERE developer_id = ${developerId} ORDER BY timestamp, id`;
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

    const ok = await consume([token!], action);
    expect(ok.statusCode, ok.body).toBe(200);
    // Each approver names the grant they approved with, so a platform
    // recording who decided never has to line two arrays up by position.
    expect(ok.json()).toMatchObject({
      consumed: true,
      jtis: [claims.jti],
      approvers: [{ sub: `user:${namespace}:${sub}`, dwell_source: 'server', jti: claims.jti }],
    });
  });

  it('refuses a request without memo or policy score, with a hash that does not match, or with duplicate member names', async () => {
    const base = { action: actionFor(newCase()), connector: 'acme_kyb', caseVersion: 'v1' };
    expect((await app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: auth(), payload: { ...base, policyScore: { content: {} } } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/decisions/requests', headers: auth(), payload: { ...base, memo: { content: 'x', hash: `sha256:${'A'.repeat(43)}` }, policyScore: { content: {} } } })).statusCode).toBe(400);
    const duplicate = await app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: { ...auth(), 'content-type': 'application/json' },
      payload: `{"action":{"case_id":"${newCase()}","action":"case_decision","decision":"approve","decision":"decline","subject":"gb:00000001"},"connector":"acme_kyb","caseVersion":"v1","memo":{"content":"x"},"policyScore":{"content":{}}}`,
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.body).toContain('repeats the member name');
  });

  it('replay with a different semantic action is denied (action_mismatch)', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    expect((await consume([token], { ...action, decision: 'decline' })).json()).toMatchObject({ reason: 'decision_invalid', subReason: 'action_mismatch' });
    expect((await consume([token], { ...action, amount: 1 })).json()).toMatchObject({ subReason: 'action_mismatch' });
  });

  it('decision-grant replay across cases is denied (wrong_case)', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    expect((await consume([token], { ...action, case_id: newCase() })).json()).toMatchObject({ subReason: 'wrong_case' });
  });

  it('replay of a consumed jti is denied and every refusal is audited with the attempted action and hash', async () => {
    const action = actionFor(newCase());
    const { token, jti } = await approvedGrant(action);
    expect((await consume([token], action)).statusCode).toBe(200);
    expect((await consume([token], action)).json()).toMatchObject({ subReason: 'consumed' });
    const refused = await sql`
      SELECT status, metadata FROM audit_entries
      WHERE developer_id = ${developerId} AND action = 'decision.consume_refused' AND metadata->'jtis' ? ${jti}`;
    expect(refused[0]).toMatchObject({ status: 'blocked', metadata: { sub_reason: 'consumed', action, action_hash: computeActionHash(action), case_version: 'v1' } });
    expect((await consume(['not-a-token'], action)).statusCode).toBe(400);
    const [malformed] = await sql`
      SELECT metadata FROM audit_entries WHERE developer_id = ${developerId} AND action = 'decision.consume_refused'
        AND metadata->>'sub_reason' = 'malformed' ORDER BY timestamp DESC LIMIT 1`;
    expect(malformed!['metadata']).toMatchObject({ jtis: [], action_hash: computeActionHash(action) });
  });

  it('an expired grant is denied (expired)', async () => {
    const action = actionFor(newCase());
    const { token, jti } = await approvedGrant(action);
    await sql`UPDATE decision_grants SET expires_at = NOW() - INTERVAL '1 second' WHERE jti = ${jti}`;
    expect((await consume([token], action)).json()).toMatchObject({ subReason: 'expired' });
  });

  it('a case-changed grant is denied (case_changed), and so is an approval in progress', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    expect((await consume([token], action, 'v2')).json()).toMatchObject({ subReason: 'case_changed' });
    const changed = await app.inject({ method: 'PUT', url: `/v1/decisions/cases/${action.case_id}`, headers: auth(), payload: { caseVersion: 'v2' } });
    expect(changed.json()).toMatchObject({ previousVersion: 'v1', caseVersion: 'v2', revokedGrants: 1 });
    expect((await consume([token], action, 'v1')).json()).toMatchObject({ subReason: 'case_changed' });

    const pendingAction = actionFor(newCase());
    const pending = await createRequest(pendingAction);
    const session = await signIn(pending.requestId, `pending_${suffix}`);
    const { viewId, csrf, actionHash } = await openPage(pending.requestId, session.cookie!);
    await app.inject({ method: 'PUT', url: `/v1/decisions/cases/${pendingAction.case_id}`, headers: auth(), payload: { caseVersion: 'v9' } });
    await sql`UPDATE decision_page_views SET rendered_at = rendered_at - INTERVAL '5 seconds' WHERE id = ${viewId!}`;
    const refused = await app.inject({
      method: 'POST', url: `/decisions/${pending.requestId}`,
      headers: { cookie: session.cookie!, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: new URLSearchParams({ view_id: viewId!, csrf_token: csrf!, action_hash: actionHash! }).toString(),
    });
    expect(refused.statusCode).toBe(409);
  });

  it('four eyes: same approver and same verified email refused, one grant incomplete, two approvers consumed together', async () => {
    const action = actionFor(newCase(), 'decline');
    const request = await createRequest(action, { fourEyesOn: ['decline'] });
    expect(request.approvalsRequired).toBe(2);
    const alice = await signIn(request.requestId, `fe_alice_${suffix}`);
    expect((await approve(request.requestId, alice.cookie!)).statusCode).toBe(200);

    const aliceAgain = await signIn(request.requestId, `fe_alice_${suffix}`);
    expect((await approve(request.requestId, aliceAgain.cookie!)).statusCode).toBe(409);

    const alias = await signIn(request.requestId, `fe_alias_${suffix}`, { email: `FE_ALICE_${suffix}@example.com` });
    expect((await approve(request.requestId, alias.cookie!)).statusCode).toBe(409);

    // The same subject at another identity provider is another approver.
    const bob = await signIn(request.requestId, `fe_alice_${suffix}`, { email: `bob_${suffix}@example.com` }, otherIdpId);
    const second = await approve(request.requestId, bob.cookie!);
    expect(second.statusCode, second.body).toBe(200);
    const tokens = await grantsFor(request.requestId);
    expect(tokens).toHaveLength(2);
    const [first, last] = tokens.map((t) => decodeJwt(t));
    expect(first!['four_eyes']).toEqual({ approvals_required: 2, position: 1 });
    expect(last!['four_eyes']).toMatchObject({ approvals_required: 2, position: 2, first_jti: first!.jti, first_sub: first!.sub });
    expect(first!.sub).not.toBe(last!.sub);

    expect((await consume([tokens[0]!], action)).json()).toMatchObject({ subReason: 'four_eyes_incomplete' });
    expect((await consume([tokens[0]!, tokens[0]!], action)).json()).toMatchObject({ subReason: 'same_approver' });
    // Presented second grant first, so the two arrays disagree: `jtis` follows
    // the presentation order and `approvers` follows the approval order. A
    // caller pairing them by index would attribute each grant to the other
    // approver, which is why each approver names its own.
    const consumed = await consume([tokens[1]!, tokens[0]!], action);
    expect(consumed.statusCode, consumed.body).toBe(200);
    expect(consumed.json()).toMatchObject({
      jtis: [last!.jti, first!.jti],
      approvers: [{ sub: first!.sub, jti: first!.jti }, { sub: last!.sub, jti: last!.jti }],
    });
    expect((await consume(tokens, action)).json()).toMatchObject({ subReason: 'consumed' });
  });

  it('two parallel consumes of one jti yield exactly one success', async () => {
    const action = actionFor(newCase());
    const { token } = await approvedGrant(action);
    const results = await Promise.allSettled([1, 2].map(() => consumePresentedDecisionGrants(sql, { developerId, tokens: [token], action, caseVersion: 'v1' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ subReason: 'consumed' });

    const second = actionFor(newCase());
    const { token: token2 } = await approvedGrant(second);
    const responses = await Promise.all(Array.from({ length: 10 }, () => consume([token2], second)));
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.json<{ subReason?: string }>().subReason === 'consumed')).toHaveLength(9);
  });

  it('parallel approvals cannot exceed the approvals a decision needs', async () => {
    const request = await createRequest(actionFor(newCase()));
    const sessions = await Promise.all([1, 2, 3, 4].map((n) => signIn(request.requestId, `race_${n}_${suffix}`)));
    const pages = await Promise.all(sessions.map((s) => openPage(request.requestId, s.cookie!)));
    await sql`UPDATE decision_page_views SET rendered_at = rendered_at - INTERVAL '5 seconds' WHERE request_id = ${request.requestId}`;
    const responses = await Promise.all(pages.map((p, i) => app.inject({
      method: 'POST', url: `/decisions/${request.requestId}`,
      headers: { cookie: sessions[i]!.cookie!, 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      payload: new URLSearchParams({ view_id: p.viewId!, csrf_token: p.csrf!, action_hash: p.actionHash! }).toString(),
    })));
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect((await sql`SELECT count(*)::int AS n FROM decision_grants WHERE request_id = ${request.requestId}`)[0]!['n']).toBe(1);
  });

  it('concurrent requests for a new case do not race on the case row', async () => {
    const caseId = newCase();
    const responses = await Promise.all(['approve', 'decline', 'close', 'file', 'hold'].map((decision) => app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: auth(),
      payload: { action: actionFor(caseId, decision), connector: 'acme_kyb', caseVersion: 'v1', memo: { content: 'm' }, policyScore: { content: {} } },
    })));
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
  });

  it('is isolated per developer; tokens are returned only while usable; cancel revokes', async () => {
    const action = actionFor(newCase());
    const { token, request } = await approvedGrant(action);
    expect((await consume([token], action, 'v1', otherApiKey)).json()).toMatchObject({ subReason: 'unknown_grant' });
    expect((await app.inject({ method: 'GET', url: `/v1/decisions/requests/${request.requestId}`, headers: auth(otherApiKey) })).statusCode).toBe(404);
    expect(await grantsFor(request.requestId)).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: `/v1/decisions/requests/${request.requestId}/cancel`, headers: auth() })).statusCode).toBe(200);
    expect((await consume([token], action)).json()).toMatchObject({ subReason: 'revoked' });
  });

  it('disabling an approver identity provider ends its sessions', async () => {
    const tempIdp = await addIdp('https://idp-three.example.com');
    const request = await createRequest(actionFor(newCase()));
    const session = await signIn(request.requestId, `disabled_${suffix}`, {}, tempIdp);
    expect(session.status).toBe(303);
    const disabled = await app.inject({ method: 'POST', url: `/v1/admin/developers/${developerId}/decision-approver-idps/${tempIdp}/disable`, headers: admin(), payload: { actor: 'ops@example.com' } });
    expect(disabled.statusCode).toBe(200);
    const page = await app.inject({ method: 'GET', url: `/decisions/${request.requestId}`, headers: { cookie: session.cookie! } });
    expect(page.statusCode).toBe(401);
  });

  // ── Decision grants and the requesting agent ────────────────────────────
  // Everything above runs with DECISION_GRANT_AGENT_BINDING unset, the
  // default, and so shows the endpoints answering as they did before the
  // binding existed. The blocks below cover what is new in each state.

  let agentCounter = 0;
  const JWS = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

  /** A registered agent of the developer with an active grant, and a grant token for that grant. */
  async function agentWithGrant(dev = developerId) {
    const label = `${++agentCounter}_${suffix}`;
    const agentId = `ag_dec_${label}`;
    const did = `did:grantex:${agentId}`;
    const grantId = `grnt_dec_${label}`;
    const jti = `tok_dec_${label}`;
    await sql`INSERT INTO agents (id, did, developer_id, name) VALUES (${agentId}, ${did}, ${dev}, 'Nimbus Shopper 2.4')`;
    await sql`
      INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
      VALUES (${grantId}, ${agentId}, 'shopper-01', ${dev}, ${['tool:acme_kyb:write']}, NOW() + INTERVAL '2 hours')`;
    await sql`INSERT INTO grant_tokens (jti, grant_id, expires_at) VALUES (${jti}, ${grantId}, NOW() + INTERVAL '1 hour')`;
    const iat = now();
    const grantToken = await signGrantToken({ sub: 'shopper-01', agt: did, dev, scp: ['tool:acme_kyb:write'], jti, grnt: grantId, iat, exp: iat + 3600 });
    return { agentId, did, grantId, grantToken };
  }

  /** Another grant token of the agent: under `grantId` when given, else under a second active grant of its own. */
  async function anotherTokenOf(agent: { agentId: string; did: string }, grantId?: string) {
    const label = `${++agentCounter}_${suffix}`;
    const grant = grantId ?? `grnt_dec_${label}`;
    const jti = `tok_dec_${label}`;
    if (grantId === undefined) {
      await sql`
        INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
        VALUES (${grant}, ${agent.agentId}, 'shopper-01', ${developerId}, ${['tool:acme_kyb:write']}, NOW() + INTERVAL '2 hours')`;
    }
    await sql`INSERT INTO grant_tokens (jti, grant_id, expires_at) VALUES (${jti}, ${grant}, NOW() + INTERVAL '1 hour')`;
    const iat = now();
    const grantToken = await signGrantToken({ sub: 'shopper-01', agt: agent.did, dev: developerId, scp: ['tool:acme_kyb:write'], jti, grnt: grant, iat, exp: iat + 3600 });
    return { jti, grantId: grant, grantToken };
  }

  /** The recorded refusals of consumptions that presented `jti`, oldest first. */
  async function consumeRefusalsOf(jti: string) {
    return sql<{ status: string; agent_id: string; agent_did: string; grant_id: string; metadata: Record<string, unknown> }[]>`
      SELECT status, agent_id, agent_did, grant_id, metadata FROM audit_entries
      WHERE developer_id = ${developerId} AND action = 'decision.consume_refused' AND metadata->'jtis' ? ${jti}
      ORDER BY timestamp, id`;
  }

  async function approveOnce(requestId: string): Promise<void> {
    const session = await signIn(requestId, `bound_${randomUUID().slice(0, 8)}`);
    const res = await approve(requestId, session.cookie!);
    expect(res.statusCode, res.body).toBe(200);
  }

  /**
   * The decision grants exactly as the service minted them, re-signed from
   * the stored claims, so a consumption test does not depend on how the
   * grants reached the caller.
   */
  async function mintedGrants(requestId: string): Promise<string[]> {
    const rows = await sql<{ claims: DecisionGrantClaims }[]>`
      SELECT claims FROM decision_grants WHERE request_id = ${requestId} ORDER BY approval_position`;
    return Promise.all(rows.map((r) => signDecisionGrant(r.claims)));
  }

  function consumeAs(decisionGrants: string[], action: DecisionAction, requester: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: auth(), payload: { decisionGrants, action, caseVersion: 'v1', ...requester } });
  }

  function consumeById(requestId: string, body: Record<string, unknown>, key = apiKey) {
    return app.inject({ method: 'POST', url: `/v1/decisions/requests/${requestId}/consume`, headers: auth(key), payload: { caseVersion: 'v1', ...body } });
  }

  function release(requestId: string, body: Record<string, unknown>, key = apiKey) {
    return app.inject({ method: 'POST', url: `/v1/decisions/requests/${requestId}/grants`, headers: auth(key), payload: body });
  }

  function repeatRequest(action: DecisionAction, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST', url: '/v1/decisions/requests', headers: auth(),
      payload: {
        action, connector: 'acme_kyb', caseVersion: 'v1',
        memo: { ref: 'memo:case/1', content: 'Registry active. Owners reconcile.' },
        policyScore: { ref: 'policy:uk/1.2.0', content: { tier: 'low', score: 12, reasons: [] } },
        ...extra,
      },
    });
  }

  async function consumedAt(requestId: string): Promise<(Date | null)[]> {
    const rows = await sql<{ consumed_at: Date | null }[]>`SELECT consumed_at FROM decision_grants WHERE request_id = ${requestId}`;
    return rows.map((r) => r.consumed_at);
  }

  async function auditFor(action: string, requestId: string) {
    return sql<{ status: string; agent_id: string; agent_did: string; grant_id: string; metadata: Record<string, unknown> }[]>`
      SELECT status, agent_id, agent_did, grant_id, metadata FROM audit_entries
      WHERE developer_id = ${developerId} AND action = ${action} AND metadata->>'request_id' = ${requestId}
      ORDER BY timestamp, id`;
  }

  describe('with DECISION_GRANT_AGENT_BINDING off (the default)', () => {
    beforeEach(() => {
      delete process.env['DECISION_GRANT_AGENT_BINDING'];
    });

    it('answers the decision grants to the developer key and consumes them for any agent, as before the binding', async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const action = actionFor(newCase());
      const created = await repeatRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      expect(created.statusCode).toBe(201);
      expect(created.json()).not.toHaveProperty('decisionGrantsReady');
      const { requestId } = created.json<{ requestId: string }>();
      await approveOnce(requestId);

      const status = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${requestId}`, headers: auth() });
      expect(status.statusCode).toBe(200);
      expect(status.json()).not.toHaveProperty('decisionGrantsReady');
      const tokens = status.json<{ decisionGrants: string[] }>().decisionGrants;
      expect(tokens).toHaveLength(1);
      expect(decodeJwt(tokens[0]!)).toMatchObject({ decision_request: requestId });

      // agentId is a Grantex agent id, as before: a DID there is malformed.
      const didAsId = await consumeAs(tokens, action, { agentId: other.did, grantId: other.grantId });
      expect(didAsId.statusCode).toBe(400);
      expect(didAsId.json<{ message: string }>().message).toMatch(/agentId/);
      // agentDid is not read at all, so an SDK that sends it works here as it
      // does against a service from before the binding; the agent and grant
      // are recorded, not compared.
      const ok = await consumeAs(tokens, action, { agentId: other.agentId, agentDid: 'not a DID', grantId: other.grantId });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ consumed: true, requestId });
      const [consumed] = await auditFor('decision.consumed', requestId);
      expect(consumed).toMatchObject({ agent_id: other.agentId, agent_did: '', grant_id: other.grantId });
    });

    it('does not read a grant token sent with a consumption: neither another agent\'s nor one that is not a token', async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      for (const grantToken of [other.grantToken, 'not a grant token', 7]) {
        const action = actionFor(newCase());
        const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
        await approveOnce(request.requestId);
        const tokens = await mintedGrants(request.requestId);
        const ok = await consumeAs(tokens, action, { grantToken, agentId: other.agentId, grantId: other.grantId });
        expect(ok.statusCode, ok.body).toBe(200);
        expect(ok.json()).toMatchObject({ consumed: true, requestId: request.requestId });
        // Recorded with the body's agent and grant, as before the binding.
        const [consumed] = await auditFor('decision.consumed', request.requestId);
        expect(consumed).toMatchObject({ agent_id: other.agentId, agent_did: '', grant_id: other.grantId });
      }
    });

    it('answers a repeated request for another agent with the open request, as before the binding', async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const action = actionFor(newCase());
      const first = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      for (const extra of [{ agentId: other.agentId, grantId: other.grantId }, {}]) {
        const again = await repeatRequest(action, extra);
        expect(again.statusCode, again.body).toBe(200);
        expect(again.json()).toMatchObject({ created: false, requestId: first.requestId, agentId: agent.agentId, grantId: agent.grantId });
        expect(again.json()).not.toHaveProperty('decisionGrantsReady');
      }
    });

    it("releases a request's grants to its agent's grant token and consumes a platform's own request by id: both are new endpoints", async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const bound = actionFor(newCase());
      const request = await createRequest(bound, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);
      expect((await release(request.requestId, { grantToken: other.grantToken })).json()).toMatchObject({ subReason: 'wrong_agent' });
      const released = await release(request.requestId, { grantToken: agent.grantToken });
      expect(released.statusCode, released.body).toBe(200);
      expect(released.json()).toMatchObject({ decisionGrantsReady: true, decisionGrants: [expect.stringMatching(JWS)] });
      expect((await consumeById(request.requestId, { action: bound })).json()).toMatchObject({ subReason: 'wrong_agent' });

      const own = actionFor(newCase());
      const platformOwn = await createRequest(own);
      await approveOnce(platformOwn.requestId);
      const consumed = await consumeById(platformOwn.requestId, { action: own });
      expect(consumed.statusCode, consumed.body).toBe(200);
      expect(consumed.json()).toMatchObject({ consumed: true, requestId: platformOwn.requestId, jtis: [expect.stringMatching(/^dgnt_/)] });
    });
  });

  describe('consuming a decision that names no agent by its id', () => {
    for (const binding of [undefined, 'true'] as const) {
      it(`consumes it once, with every check, and refuses one an agent asked for (DECISION_GRANT_AGENT_BINDING ${binding ?? 'unset'})`, async () => {
        if (binding === undefined) delete process.env['DECISION_GRANT_AGENT_BINDING'];
        else process.env['DECISION_GRANT_AGENT_BINDING'] = binding;
        try {
          const action = actionFor(newCase());
          const request = await createRequest(action);
          const byId = (body: Record<string, unknown>) => consumeById(request.requestId, { action, ...body });

          // Not approved yet: there is nothing to consume.
          expect((await byId({})).json()).toMatchObject({ subReason: 'unknown_grant' });
          await approveOnce(request.requestId);
          expect((await byId({ action: { ...action, decision: 'decline' } })).json()).toMatchObject({ subReason: 'action_mismatch' });
          expect((await byId({ caseVersion: 'v2' })).json()).toMatchObject({ subReason: 'case_changed' });

          // Parallel consumptions by id: exactly one succeeds.
          const responses = await Promise.all(Array.from({ length: 5 }, () => byId({})));
          const ok = responses.find((r) => r.statusCode === 200)!;
          expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
          expect(responses.filter((r) => r.json<{ subReason?: string }>().subReason === 'consumed')).toHaveLength(4);
          expect(ok.json()).toMatchObject({ consumed: true, requestId: request.requestId, jtis: [expect.stringMatching(/^dgnt_/)], approvers: [{ dwell_source: 'server' }] });
          const [consumedEntry] = await auditFor('decision.consumed', request.requestId);
          expect(consumedEntry!.metadata).toMatchObject({ consumed_by: 'decision_request', action_hash: computeActionHash(action) });
          const refusals = await auditFor('decision.consume_refused', request.requestId);
          expect(refusals.map((r) => r.metadata['sub_reason'])).toEqual(expect.arrayContaining(['unknown_grant', 'action_mismatch', 'case_changed', 'consumed']));
          expect((await byId({})).json()).toMatchObject({ subReason: 'consumed' });

          // Another developer's key cannot see it; an unknown id is not found.
          const other = await consumeById(request.requestId, { action }, otherApiKey);
          expect(other.statusCode).toBe(404);
          expect(other.json()).toMatchObject({ subReason: 'unknown_grant' });
          expect((await consumeById('dreq_not_an_id', { action })).statusCode).toBe(404);

          // A decision an agent asked for is spent only with the grants that agent presents.
          const agent = await agentWithGrant();
          const bound = actionFor(newCase());
          const boundRequest = await createRequest(bound, { grantId: agent.grantId });
          await approveOnce(boundRequest.requestId);
          const refused = await consumeById(boundRequest.requestId, { action: bound });
          expect(refused.statusCode).toBe(403);
          expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
          expect(await consumedAt(boundRequest.requestId)).toEqual([null]);
        } finally {
          delete process.env['DECISION_GRANT_AGENT_BINDING'];
        }
      });

      it(`is not consumed by a request id in the body of POST /v1/decisions/consume (DECISION_GRANT_AGENT_BINDING ${binding ?? 'unset'})`, async () => {
        if (binding === undefined) delete process.env['DECISION_GRANT_AGENT_BINDING'];
        else process.env['DECISION_GRANT_AGENT_BINDING'] = binding;
        try {
          const action = actionFor(newCase());
          const request = await createRequest(action);
          await approveOnce(request.requestId);
          // That endpoint consumes only presented grants; without them the body is malformed.
          for (const member of ['decisionRequest', 'requestId']) {
            const res = await app.inject({ method: 'POST', url: '/v1/decisions/consume', headers: auth(), payload: { [member]: request.requestId, action, caseVersion: 'v1' } });
            expect(res.statusCode, member).toBe(400);
            expect(res.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'malformed' });
          }
          expect(await consumedAt(request.requestId)).toEqual([null]);
          // The request is still there to consume by its id, on its own endpoint.
          const consumed = await consumeById(request.requestId, { action });
          expect(consumed.statusCode, consumed.body).toBe(200);
        } finally {
          delete process.env['DECISION_GRANT_AGENT_BINDING'];
        }
      });
    }
  });

  describe('with DECISION_GRANT_AGENT_BINDING=true', () => {
    beforeEach(() => {
      process.env['DECISION_GRANT_AGENT_BINDING'] = 'true';
    });

    afterEach(() => {
      delete process.env['DECISION_GRANT_AGENT_BINDING'];
    });

    it("consume refuses another agent's decision grant (wrong_agent)", async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);
      const tokens = await mintedGrants(request.requestId);

      // Another agent of the same developer, with a live grant of its own,
      // by the DID an enforcer reports or by its Grantex agent id.
      for (const requester of [{ agentDid: other.did, grantId: other.grantId }, { agentId: other.agentId, grantId: other.grantId }]) {
        const refused = await consumeAs(tokens, action, requester);
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
        // Presenting its own live grant token does not make it the requester.
        const withToken = await consumeAs(tokens, action, { grantToken: other.grantToken, ...requester });
        expect(withToken.statusCode, withToken.body).toBe(403);
        expect(withToken.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
      }
      // The right agent under another grant is not the requester either, and
      // every agent reference given must be the right one.
      expect((await consumeAs(tokens, action, { agentDid: agent.did, grantId: other.grantId })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect((await consumeAs(tokens, action, { agentDid: agent.did, agentId: other.agentId, grantId: agent.grantId })).json()).toMatchObject({ subReason: 'wrong_agent' });
      const secondGrant = await anotherTokenOf(agent);
      expect((await consumeAs(tokens, action, { grantToken: secondGrant.grantToken })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect((await consumeAs(tokens, action, { grantToken: agent.grantToken, agentId: other.agentId })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect(await consumedAt(request.requestId)).toEqual([null]);
      // The refusal names the agent its grant token established.
      const [audited] = await sql<{ status: string; agent_did: string; grant_id: string; metadata: Record<string, unknown> }[]>`
        SELECT status, agent_did, grant_id, metadata FROM audit_entries
        WHERE developer_id = ${developerId} AND action = 'decision.consume_refused' AND agent_did = ${other.did}`;
      expect(audited).toMatchObject({ status: 'blocked', grant_id: other.grantId, metadata: { sub_reason: 'wrong_agent', action_hash: computeActionHash(action) } });

      // The agent the request names consumes it with its grant token; the
      // DID and grant an enforcer reports, and the agent id the request named
      // it by, are that token's.
      const ok = await consumeAs(tokens, action, { grantToken: agent.grantToken, agentDid: agent.did, agentId: agent.agentId, grantId: agent.grantId });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ consumed: true, requestId: request.requestId });
      const [consumed] = await auditFor('decision.consumed', request.requestId);
      expect(consumed).toMatchObject({ agent_id: agent.agentId, agent_did: agent.did, grant_id: agent.grantId });
    });

    it('consume refuses when the agent is omitted but the request is bound', async () => {
      const agent = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);
      const tokens = await mintedGrants(request.requestId);

      for (const requester of [{}, { grantId: agent.grantId }, { agentDid: agent.did }, { agentId: agent.agentId }]) {
        const res = await consumeAs(tokens, action, requester);
        expect(res.statusCode, JSON.stringify(requester)).toBe(403);
        expect(res.json()).toMatchObject({ subReason: 'wrong_agent' });
      }
      expect(await consumedAt(request.requestId)).toEqual([null]);

      // A request bound only to a grant needs only that grant, which the
      // grant token carries. Naming the right agent and grant in the body is
      // not that token.
      const grantOnly = actionFor(newCase());
      const second = await createRequest(grantOnly, { grantId: agent.grantId });
      await approveOnce(second.requestId);
      const secondTokens = await mintedGrants(second.requestId);
      expect((await consumeAs(secondTokens, grantOnly, { agentDid: agent.did })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect((await consumeAs(secondTokens, grantOnly, { agentDid: agent.did, grantId: agent.grantId })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect(await consumedAt(second.requestId)).toEqual([null]);
      expect((await consumeAs(secondTokens, grantOnly, { grantToken: agent.grantToken })).statusCode).toBe(200);
      // A platform that names the agent by its Grantex agent id is the same
      // agent, when that agent's grant token comes with it.
      expect((await consumeAs(tokens, action, { agentId: agent.agentId, grantId: agent.grantId })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect((await consumeAs(tokens, action, { grantToken: agent.grantToken, agentId: agent.agentId, grantId: agent.grantId })).statusCode).toBe(200);
    });

    it("consumes a bound decision only with its agent's grant token: body members naming the right agent are not enough, and with the token they may be omitted", async () => {
      const agent = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);
      const tokens = await mintedGrants(request.requestId);
      const jti = decodeJwt(tokens[0]!).jti as string;

      // The developer API key with every member naming the right agent and grant, but no grant token.
      for (const requester of [
        { agentDid: agent.did, grantId: agent.grantId },
        { agentId: agent.agentId, grantId: agent.grantId },
        { agentId: agent.agentId, agentDid: agent.did, grantId: agent.grantId },
      ]) {
        const refused = await consumeAs(tokens, action, requester);
        expect(refused.statusCode, JSON.stringify(requester)).toBe(403);
        expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
      }
      expect(await consumedAt(request.requestId)).toEqual([null]);
      // Recorded with no agent (none was established) and the claims apart.
      const refusals = await consumeRefusalsOf(jti);
      expect(refusals).toHaveLength(3);
      expect(refusals[0]).toMatchObject({
        status: 'blocked', agent_id: '', agent_did: '', grant_id: '',
        metadata: { sub_reason: 'wrong_agent', token_check: 'missing', claimed_agent_did: agent.did, claimed_grant_id: agent.grantId },
      });

      // The agent's grant token alone: consumed, and recorded as that agent.
      const ok = await consumeAs(tokens, action, { grantToken: agent.grantToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ consumed: true, requestId: request.requestId, jtis: [jti] });
      const [consumed] = await auditFor('decision.consumed', request.requestId);
      expect(consumed).toMatchObject({ agent_id: agent.agentId, agent_did: agent.did, grant_id: agent.grantId });
    });

    it("refuses another agent's live grant token presented with the requesting agent's ids in the body", async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);
      const tokens = await mintedGrants(request.requestId);
      const jti = decodeJwt(tokens[0]!).jti as string;

      for (const requester of [
        { agentDid: agent.did, grantId: agent.grantId },
        { agentId: agent.agentId, grantId: agent.grantId },
        { agentId: agent.agentId, agentDid: agent.did, grantId: agent.grantId },
        { agentDid: agent.did },
        { grantId: agent.grantId },
      ]) {
        const refused = await consumeAs(tokens, action, { grantToken: other.grantToken, ...requester });
        expect(refused.statusCode, JSON.stringify(requester)).toBe(403);
        expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
      }
      expect(await consumedAt(request.requestId)).toEqual([null]);
      // Recorded as the agent the token established, with what the body claimed apart.
      const [first] = await consumeRefusalsOf(jti);
      expect(first).toMatchObject({
        agent_did: other.did, grant_id: other.grantId,
        metadata: { sub_reason: 'wrong_agent', claimed_agent_did: agent.did, claimed_grant_id: agent.grantId },
      });
      expect(first!.metadata).not.toHaveProperty('token_check');

      expect((await consumeAs(tokens, action, { grantToken: agent.grantToken, agentDid: agent.did, grantId: agent.grantId })).statusCode).toBe(200);
    });

    it('refuses an expired, revoked, unknown, other developer\'s or unverifiable grant token whatever the body says, and consumes nothing', async () => {
      const agent = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);
      const tokens = await mintedGrants(request.requestId);
      const jti = decodeJwt(tokens[0]!).jti as string;

      // Tokens of the right agent and grant that are no longer live.
      const lapsed = await anotherTokenOf(agent, agent.grantId);
      await sql`UPDATE grant_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE jti = ${lapsed.jti}`;
      const revoked = await anotherTokenOf(agent, agent.grantId);
      await sql`UPDATE grant_tokens SET is_revoked = TRUE WHERE jti = ${revoked.jti}`;
      // Signed by this service for the right agent and grant, but never issued.
      const iat = now();
      const unknown = await signGrantToken({ sub: 'shopper-01', agt: agent.did, dev: developerId, scp: ['tool:acme_kyb:write'], jti: `tok_dec_unknown_${suffix}`, grnt: agent.grantId, iat, exp: iat + 3600 });
      // A live token of another developer's agent.
      const foreign = await agentWithGrant(otherDeveloperId);
      const cases: [string, string][] = [
        [lapsed.grantToken, 'expired'],
        [revoked.grantToken, 'revoked'],
        [unknown, 'not_found'],
        [foreign.grantToken, 'wrong_developer'],
        ['not-a-grant-token', 'invalid'],
        [`${agent.grantToken.split('.').slice(0, 2).join('.')}.${'A'.repeat(43)}`, 'invalid'],
      ];
      for (const [grantToken] of cases) {
        const refused = await consumeAs(tokens, action, { grantToken, agentId: agent.agentId, agentDid: agent.did, grantId: agent.grantId });
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
        expect(refused.json<{ message: string }>().message).toMatch(/grantToken is not a live grant token/);
      }
      expect(await consumedAt(request.requestId)).toEqual([null]);
      const refusals = await consumeRefusalsOf(jti);
      expect(refusals.map((r) => r.metadata['token_check'])).toEqual(cases.map(([, check]) => check));
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ status: 'blocked', agent_did: '', grant_id: '', metadata: { sub_reason: 'wrong_agent', claimed_agent_id: agent.agentId } });
      }

      // The live token still consumes it.
      expect((await consumeAs(tokens, action, { grantToken: agent.grantToken })).statusCode).toBe(200);
    });

    it('consumes the presented grants of a request that names no agent as before: no grant token is needed, and one given must be live', async () => {
      const live = await agentWithGrant();
      const request = async () => {
        const action = actionFor(newCase());
        const created = await createRequest(action);
        await approveOnce(created.requestId);
        return { action, requestId: created.requestId, tokens: await mintedGrants(created.requestId) };
      };

      // No grant token and no agent, as before the binding.
      const bare = await request();
      const ok = await consumeAs(bare.tokens, bare.action, {});
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await auditFor('decision.consumed', bare.requestId))[0]).toMatchObject({ agent_id: '', agent_did: '', grant_id: '' });

      // Body members without a token are still accepted, but, unverified, not recorded as the consuming agent.
      const claimed = await request();
      expect((await consumeAs(claimed.tokens, claimed.action, { agentDid: live.did, agentId: live.agentId, grantId: live.grantId })).statusCode).toBe(200);
      expect((await auditFor('decision.consumed', claimed.requestId))[0]).toMatchObject({ agent_id: '', agent_did: '', grant_id: '' });

      // A token that is not live fails closed here too; a live one is recorded as its agent.
      const tokened = await request();
      const refused = await consumeAs(tokened.tokens, tokened.action, { grantToken: 'not-a-grant-token' });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ subReason: 'wrong_agent' });
      expect(await consumedAt(tokened.requestId)).toEqual([null]);
      const other = await agentWithGrant();
      expect((await consumeAs(tokened.tokens, tokened.action, { grantToken: live.grantToken, agentDid: other.did })).json()).toMatchObject({ subReason: 'wrong_agent' });
      expect(await consumedAt(tokened.requestId)).toEqual([null]);
      expect((await consumeAs(tokened.tokens, tokened.action, { grantToken: live.grantToken })).statusCode).toBe(200);
      expect((await auditFor('decision.consumed', tokened.requestId))[0]).toMatchObject({ agent_id: '', agent_did: live.did, grant_id: live.grantId });
    });

    it('refuses a malformed agentDid and a DID given as agentId', async () => {
      const agent = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId });
      await approveOnce(request.requestId);
      const tokens = await mintedGrants(request.requestId);
      for (const requester of [{ agentDid: 'not a DID' }, { agentDid: 'did:Grantex:x' }, { agentDid: `did:grantex:${'a'.repeat(600)}` }, { agentDid: 7 }, { agentId: agent.did }]) {
        const res = await consumeAs(tokens, action, requester);
        expect(res.statusCode, JSON.stringify(requester).slice(0, 60)).toBe(400);
      }
      expect(await consumedAt(request.requestId)).toEqual([null]);
    });

    it('retrieval does not return bearer decision grants to the developer key, and every release is audited', async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const action = actionFor(newCase());
      const request = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      await approveOnce(request.requestId);

      const status = await app.inject({ method: 'GET', url: `/v1/decisions/requests/${request.requestId}`, headers: auth() });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({ status: 'approved', decisionGrantsReady: true, agentId: agent.agentId, grantId: agent.grantId, approvals: [{ jti: expect.stringMatching(/^dgnt_/) }] });
      expect(status.json()).not.toHaveProperty('decisionGrants');
      // No compact JWS anywhere in the answer.
      expect(status.body).not.toMatch(JWS);

      // The developer key alone, or with another agent's grant token, gets nothing.
      expect((await release(request.requestId, {})).statusCode).toBe(400);
      const wrong = await release(request.requestId, { grantToken: other.grantToken });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ subReason: 'wrong_agent' });
      expect(wrong.body).not.toMatch(JWS);
      // Another developer cannot see the request, even with the right agent's token.
      expect((await release(request.requestId, { grantToken: agent.grantToken }, otherApiKey)).statusCode).toBe(404);

      // The requesting agent's grant token releases them, and they consume.
      const released = await release(request.requestId, { grantToken: agent.grantToken });
      expect(released.statusCode, released.body).toBe(200);
      const tokens = released.json<{ decisionGrants: string[] }>().decisionGrants;
      expect(tokens).toHaveLength(1);
      const jti = decodeJwt(tokens[0]!).jti as string;
      expect(decodeJwt(tokens[0]!)).toMatchObject({ decision_request: request.requestId });

      // The refusal and the hand-out are in the audit chain.
      const refusals = await auditFor('decision.release_refused', request.requestId);
      expect(refusals).toEqual([expect.objectContaining({
        status: 'blocked', agent_id: agent.agentId, agent_did: other.did, grant_id: other.grantId,
        metadata: expect.objectContaining({ sub_reason: 'wrong_agent', requested_grant_id: agent.grantId }),
      })]);
      const handOuts = await auditFor('decision.grants_released', request.requestId);
      expect(handOuts).toEqual([expect.objectContaining({
        status: 'success', agent_id: agent.agentId, agent_did: agent.did, grant_id: agent.grantId,
        metadata: expect.objectContaining({ jtis: [jti], action_hash: computeActionHash(action) }),
      })]);

      expect((await consumeAs(tokens, action, { grantToken: agent.grantToken, agentDid: agent.did, grantId: agent.grantId })).statusCode).toBe(200);
      // Once spent there is nothing left to release, and nothing is recorded as released.
      const spent = await release(request.requestId, { grantToken: agent.grantToken });
      expect(spent.json()).toMatchObject({ status: 'consumed', decisionGrantsReady: false });
      expect(spent.json()).not.toHaveProperty('decisionGrants');
      expect(await auditFor('decision.grants_released', request.requestId)).toHaveLength(1);
    });

    it('releases nothing to a revoked or expired grant, or for a request that names no agent', async () => {
      const agent = await agentWithGrant();
      const bound = actionFor(newCase());
      const request = await createRequest(bound, { agentId: agent.agentId });
      await approveOnce(request.requestId);
      await sql`UPDATE grants SET status = 'revoked' WHERE id = ${agent.grantId}`;
      const revoked = await release(request.requestId, { grantToken: agent.grantToken });
      expect(revoked.statusCode).toBe(403);
      expect(revoked.json()).toMatchObject({ subReason: 'wrong_agent' });
      expect(revoked.body).not.toMatch(JWS);
      const [revokedEntry] = await auditFor('decision.release_refused', request.requestId);
      expect(revokedEntry).toMatchObject({ agent_did: '', grant_id: '', metadata: { sub_reason: 'wrong_agent', token_check: 'revoked' } });

      const lapsed = await agentWithGrant();
      const second = await createRequest(actionFor(newCase()), { agentId: lapsed.agentId, grantId: lapsed.grantId });
      await approveOnce(second.requestId);
      await sql`UPDATE grant_tokens SET expires_at = NOW() - INTERVAL '1 second' WHERE grant_id = ${lapsed.grantId}`;
      const expired = await release(second.requestId, { grantToken: lapsed.grantToken });
      expect(expired.statusCode).toBe(403);
      expect(expired.json()).toMatchObject({ subReason: 'wrong_agent' });

      const live = await agentWithGrant();
      const unbound = actionFor(newCase());
      const platformOwn = await createRequest(unbound);
      await approveOnce(platformOwn.requestId);
      const refused = await release(platformOwn.requestId, { grantToken: live.grantToken });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ subReason: 'wrong_agent' });
      const [unboundEntry] = await auditFor('decision.release_refused', platformOwn.requestId);
      expect(unboundEntry).toMatchObject({ agent_id: '', agent_did: live.did, grant_id: live.grantId });
    });

    it('four eyes: both grants are released to the agent and consumed together as that agent', async () => {
      const agent = await agentWithGrant();
      const action = actionFor(newCase(), 'decline');
      const request = await createRequest(action, { fourEyesOn: ['decline'], agentId: agent.agentId, grantId: agent.grantId });
      expect(request.approvalsRequired).toBe(2);
      const alice = await signIn(request.requestId, `bound_fe_alice_${suffix}`);
      expect((await approve(request.requestId, alice.cookie!)).statusCode).toBe(200);
      const halfway = await release(request.requestId, { grantToken: agent.grantToken });
      expect(halfway.json()).toMatchObject({ status: 'pending', approvalsReceived: 1, decisionGrantsReady: false });
      expect(halfway.json()).not.toHaveProperty('decisionGrants');
      const bob = await signIn(request.requestId, `bound_fe_bob_${suffix}`, { email: `bound_fe_bob_${suffix}@example.com` }, otherIdpId);
      expect((await approve(request.requestId, bob.cookie!)).statusCode).toBe(200);

      const tokens = (await release(request.requestId, { grantToken: agent.grantToken })).json<{ decisionGrants: string[] }>().decisionGrants;
      expect(tokens).toHaveLength(2);
      expect((await consumeAs([tokens[0]!], action, { grantToken: agent.grantToken, agentDid: agent.did, grantId: agent.grantId })).json()).toMatchObject({ subReason: 'four_eyes_incomplete' });
      const consumed = await consumeAs([tokens[1]!, tokens[0]!], action, { grantToken: agent.grantToken, agentDid: agent.did, grantId: agent.grantId });
      expect(consumed.statusCode, consumed.body).toBe(200);
      expect(consumed.json<{ jtis: string[] }>().jtis).toHaveLength(2);
    });

    it('refuses a repeated request for another agent or grant, and answers a repeat for the same one as it stands', async () => {
      const agent = await agentWithGrant();
      const other = await agentWithGrant();
      const action = actionFor(newCase());
      const first = await createRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      for (const extra of [{ agentId: other.agentId, grantId: other.grantId }, { agentId: agent.agentId, grantId: other.grantId }, { agentId: agent.agentId }, {}]) {
        const again = await repeatRequest(action, extra);
        expect(again.statusCode, JSON.stringify(extra)).toBe(409);
        expect(again.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'wrong_agent' });
        expect(again.body).not.toContain(first.requestId);
      }
      // A platform's own open request is not handed to an agent either.
      const own = actionFor(newCase());
      await createRequest(own);
      expect((await repeatRequest(own, { agentId: agent.agentId })).json()).toMatchObject({ subReason: 'wrong_agent' });

      // The same agent and grant: the open request, with its approvals as they stand.
      const pending = await repeatRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      expect(pending.statusCode).toBe(200);
      expect(pending.json()).toMatchObject({ created: false, requestId: first.requestId, approvalsReceived: 0, decisionGrantsReady: false });
      await approveOnce(first.requestId);
      const approved = await repeatRequest(action, { agentId: agent.agentId, grantId: agent.grantId });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({
        created: false, requestId: first.requestId, status: 'approved', approvalsReceived: 1, decisionGrantsReady: true,
        approvals: [{ jti: expect.stringMatching(/^dgnt_/) }], approvalPage: expect.stringContaining(first.requestId),
      });
      expect(approved.json()).not.toHaveProperty('decisionGrants');
      expect(approved.body).not.toMatch(JWS);
    });
  });
});
