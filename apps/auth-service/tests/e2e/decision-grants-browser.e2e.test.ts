/**
 * Decision grants (PRD G-3) end to end, over real HTTP and a real browser:
 *
 * - the auth service listens on a local port, backed by real Postgres;
 * - the service administrator allow-lists an OpenID Connect provider with the
 *   admin credential;
 * - the platform creates a decision request with the TypeScript SDK and its
 *   developer API key;
 * - the approver opens the approval page in Chromium (Playwright), signs in
 *   through the auth service's own authorization code flow (PKCE, state,
 *   nonce) at an in-test OpenID Connect provider, is refused with a password
 *   alone, steps up with a security key, reviews the page and approves;
 * - the agent calls `enforce()` from the TypeScript SDK (and, when
 *   `GRANTEX_E2E_PYTHON` names a Python with the SDK's dependencies, the
 *   Python SDK), which verifies the decision grant against the service's JWK
 *   Set and consumes it at the service: the tool call is allowed once, a
 *   replay is refused, and a four-eyes decision cannot be approved twice by
 *   one person.
 *
 * The identity provider is https://idp.example.com, an in-test provider that
 * issues ES256 ID tokens and checks the PKCE verifier. The browser reaches it
 * over TLS on a local port (Chromium maps the host name; the certificate is a
 * throwaway self-signed one made with `openssl`), and the service's
 * server-side calls (discovery, JWKS, token) reach the same provider through
 * the outbound-fetch test hook, because the service refuses loopback
 * addresses. The auth service itself is not modified or stubbed.
 *
 * Run: AUDIT_INTEGRATION_DATABASE_URL=... npm run test:e2e (after
 * `npx playwright install chromium`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createTestDatabase } from '../helpers/database.js';
import { signGrantToken } from '../../src/lib/crypto.js';
import { hashApiKey } from '../../src/lib/hash.js';
import { setSafeFetchForTests } from '../../src/lib/url-security.js';
import { clearApproverIdpCaches } from '../../src/lib/decisions/approver-oidc.js';
import { buildTestApp, sqlMock, TEST_ADMIN_API_KEY } from '../helpers.js';
import { Grantex } from '../../../../packages/sdk-ts/src/client.js';
import { ToolManifest } from '../../../../packages/sdk-ts/src/manifest.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the decision-grant browser test');
}
const describeE2e = databaseUrl ? describe : describe.skip;
// A database of its own, like every integration file; see FINDINGS G-24 and G-30.
let dropTestDatabase: (() => Promise<void>) | undefined;
const python = process.env['GRANTEX_E2E_PYTHON'];

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SCREENSHOTS = join(HERE, '..', '..', 'test-results', 'decision-grants');
const IDP = 'https://idp.example.com';
const CLIENT_ID = 'grantex-approvals';
const SESSION_COOKIE = '__Host-grantex_decision_session';

interface PendingCode { sub: string; amr: string[]; nonce: string; challenge: string; redirectUri: string }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A minimal OpenID Connect provider: discovery, JWKS, a sign-in form, and a token endpoint with PKCE. */
class TestOidcProvider {
  readonly codes = new Map<string, PendingCode>();
  readonly tokenRequests: URLSearchParams[] = [];
  #key!: CryptoKey;
  #jwk!: Record<string, unknown>;

  async init(): Promise<void> {
    const pair = await generateKeyPair('ES256');
    this.#key = pair.privateKey;
    this.#jwk = { ...(await exportJWK(pair.publicKey)), kid: 'idp-e2e', alg: 'ES256', use: 'sig' };
  }

  async handle(url: URL, method: string, body: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const json = (value: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: IDP, authorization_endpoint: `${IDP}/authorize`, token_endpoint: `${IDP}/token`, jwks_uri: `${IDP}/jwks`,
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['ES256'],
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [this.#jwk] });
    if (url.pathname === '/authorize' && method === 'GET') {
      const p = url.searchParams;
      if (p.get('client_id') !== CLIENT_ID || p.get('response_type') !== 'code' || p.get('code_challenge_method') !== 'S256'
          || !p.get('state') || !p.get('nonce') || !p.get('code_challenge') || !p.get('redirect_uri')) {
        return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'invalid authorization request' };
      }
      const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge']
        .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(p.get(name)!)}">`).join('');
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><title>Example IdP</title><h1>Example workforce sign-in</h1>
<form method="post" action="${IDP}/authorize">${hidden}
<label>User <input name="username" autocomplete="off"></label>
<button name="method" value="pwd">Sign in with password</button>
<button name="method" value="hwk">Sign in with security key</button>
</form>`,
      };
    }
    if (url.pathname === '/authorize' && method === 'POST') {
      const form = new URLSearchParams(body);
      const code = randomUUID();
      this.codes.set(code, {
        sub: form.get('username') ?? '',
        amr: form.get('method') === 'hwk' ? ['pwd', 'hwk'] : ['pwd'],
        nonce: form.get('nonce') ?? '',
        challenge: form.get('code_challenge') ?? '',
        redirectUri: form.get('redirect_uri') ?? '',
      });
      const back = new URL(form.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', form.get('state') ?? '');
      return { status: 302, headers: { location: back.toString() }, body: '' };
    }
    if (url.pathname === '/token' && method === 'POST') {
      const form = new URLSearchParams(body);
      this.tokenRequests.push(form);
      const pending = this.codes.get(form.get('code') ?? '');
      this.codes.delete(form.get('code') ?? '');
      if (!pending || form.get('client_id') !== CLIENT_ID || form.get('redirect_uri') !== pending.redirectUri
          || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== pending.challenge) {
        return json({ error: 'invalid_grant' }, 400);
      }
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: pending.nonce, amr: pending.amr, auth_time: now - 5,
        email: `${pending.sub}@example.com`, email_verified: true, name: `Approver ${pending.sub}`,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'idp-e2e' })
        .setIssuer(IDP).setAudience(CLIENT_ID).setSubject(pending.sub)
        .setIssuedAt(now).setExpirationTime(now + 300)
        .sign(this.#key);
      return json({ id_token: idToken, token_type: 'Bearer', access_token: 'opaque-access-token' });
    }
    return json({ error: 'not_found' }, 404);
  }
}

describeE2e('decision grants in a real browser against a live auth service', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const developerId = `dev_e2e_${suffix}`;
  const apiKey = `gx_test_e2e_${suffix}_key`;
  const provider = new TestOidcProvider();
  const savedEnv = { ...process.env };
  const savedConfig = { publicBaseUrl: config.publicBaseUrl, jwtIssuer: config.jwtIssuer };
  let sql: ReturnType<typeof postgres>;
  let app: FastifyInstance;
  let browser: Browser;
  let idpServer: HttpsServer | undefined;
  let tlsDir = '';
  let base = '';
  let grantex: Grantex;
  let caseCounter = 0;

  const newCase = () => `case_e2e_${suffix}_${++caseCounter}`;
  const actionFor = (caseId: string, decision: string) => ({ case_id: caseId, action: 'case_decision', decision, subject: 'gb:00000001' });
  const callArguments = (caseId: string, decision: string) => ({ case_id: caseId, decision, subject: 'gb:00000001', note: 'planned by the agent' });

  async function agentGrantToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return signGrantToken({
      sub: 'user_e2e', agt: 'did:grantex:ag_e2e', dev: developerId, scp: ['tool:acme_kyb:write'],
      jti: `tok_e2e_${randomUUID().slice(0, 8)}`, grnt: `grnt_e2e_${suffix}`, iat: now, exp: now + 3600,
    });
  }

  async function newContext(): Promise<BrowserContext> {
    // The identity provider's certificate is self-signed for this test.
    return browser.newContext({ ignoreHTTPSErrors: true });
  }

  async function signIn(page: Page, approvalPage: string, user: string, method: 'pwd' | 'hwk'): Promise<void> {
    await page.goto(approvalPage);
    await page.getByRole('heading', { name: 'Sign in to review this decision' }).waitFor();
    await page.getByRole('link', { name: 'Sign in with Example Workforce' }).click();
    await page.waitForLoadState('load');
    if (!page.url().startsWith(`${IDP}/authorize?`)) {
      throw new Error(`sign-in did not reach the identity provider: ${page.url()}: ${(await page.locator('body').innerText()).slice(0, 500)}`);
    }
    await page.getByLabel('User').fill(user);
    await page.getByRole('button', { name: method === 'hwk' ? 'Sign in with security key' : 'Sign in with password' }).click();
  }

  async function createRequest(caseId: string, decision: string) {
    const created = await grantex.decisions.createRequest({
      action: actionFor(caseId, decision),
      connector: 'acme_kyb',
      caseVersion: 'v1',
      memo: { ref: 'memo:e2e/1', content: `Registry record active; owners reconcile. Proposed: ${decision}.` },
      policyScore: { ref: 'policy:uk/1.2.0', content: { tier: 'low', score: 12 } },
      fourEyesOn: ['decline'],
    });
    return created as { requestId: string; approvalPage: string; actionHash: string; approvalsRequired: number };
  }

  async function approveOnPage(page: Page, decision: string): Promise<void> {
    await page.getByRole('heading', { name: 'Review and approve this decision' }).waitFor();
    // Dwell time is measured by the service; approving faster than the minimum is refused.
    await page.waitForTimeout(2_300);
    await page.getByRole('button', { name: `Approve: ${decision}` }).click();
  }

  async function grantsFor(requestId: string): Promise<string[]> {
    const found = await grantex.decisions.getRequest(requestId) as { decisionGrants?: string[] };
    return found.decisionGrants ?? [];
  }

  function enforceTs(grantToken: string, caseId: string, decision: string, decisionGrants?: string[]) {
    return grantex.enforce({
      grantToken, connector: 'acme_kyb', tool: 'case_decision', caseVersion: 'v1',
      arguments: callArguments(caseId, decision),
      ...(decisionGrants ? { decisionGrants } : {}),
    });
  }

  beforeAll(async () => {
    mkdirSync(SCREENSHOTS, { recursive: true });
    const db = await createTestDatabase('decision_e2e');
    dropTestDatabase = db.drop;
    sql = postgres(db.url, { max: 10, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    await runMigrations(sql);
    await sql`INSERT INTO developers (id, api_key_hash, name) VALUES (${developerId}, ${hashApiKey(apiKey)}, 'Decision E2E')`;
    await provider.init();

    const port = await freePort();
    base = `http://localhost:${port}`;
    // The service's public origin and issuer are this local listener.
    Object.assign(config as { publicBaseUrl: string; jwtIssuer: string }, { publicBaseUrl: base, jwtIssuer: base });
    process.env['DECISION_GRANTS_ENABLED'] = 'true';
    process.env['DECISION_STEP_UP_AMR'] = 'hwk';
    process.env['DECISION_MIN_DWELL_MS'] = '2000';

    setSafeFetchForTests(async (value, init) => {
      const url = new URL(value);
      if (url.origin !== IDP) throw new Error(`unexpected outbound request to ${url.origin}`);
      const response = await provider.handle(url, init.method ?? 'GET', typeof init.body === 'string' ? init.body : String(init.body ?? ''));
      return new Response(response.status === 302 ? null : response.body, { status: response.status, headers: response.headers });
    });

    app = await buildTestApp();
    await app.listen({ port, host: 'localhost' });
    tlsDir = mkdtempSync(join(tmpdir(), 'grantex-e2e-idp-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'),
      '-subj', '/CN=idp.example.com', '-addext', 'subjectAltName=DNS:idp.example.com',
    ], { stdio: 'ignore' });
    idpServer = createHttpsServer({ key: readFileSync(join(tlsDir, 'key.pem')), cert: readFileSync(join(tlsDir, 'cert.pem')) }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        provider.handle(new URL(req.url ?? '/', IDP), req.method ?? 'GET', Buffer.concat(chunks).toString('utf8'))
          .then((response) => {
            res.writeHead(response.status, response.headers);
            res.end(response.body);
          })
          .catch(() => {
            res.writeHead(500);
            res.end();
          });
      });
    });
    const idpPort = await freePort();
    await new Promise<void>((resolve) => idpServer!.listen(idpPort, '127.0.0.1', resolve));
    browser = await chromium.launch({ args: [`--host-rules=MAP idp.example.com 127.0.0.1:${idpPort}`] });

    grantex = new Grantex({ apiKey, baseUrl: base, issuer: base, maxRetries: 0 });
    grantex.loadManifest(ToolManifest.fromJSON({
      connector: 'acme_kyb',
      tools: { case_decision: { permission: 'write', requires_decision: true, four_eyes_on: ['decline'] } },
    }));
  }, 180_000);

  beforeEach(async () => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin(cb as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, parameters?: unknown[]) => sql.unsafe(query, parameters as never)) as never);
    clearApproverIdpCaches();
    const idps = await sql`SELECT id FROM decision_approver_idps WHERE developer_id = ${developerId}`;
    if (idps.length === 0) {
      const res = await fetch(`${base}/v1/admin/developers/${developerId}/decision-approver-idps`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_ADMIN_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: IDP, clientId: CLIENT_ID, displayName: 'Example Workforce', actor: 'ops@example.com' }),
      });
      expect(res.status, await res.clone().text()).toBe(201);
      // The developer API key cannot do the same.
      const denied = await fetch(`${base}/v1/admin/developers/${developerId}/decision-approver-idps`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ issuer: 'https://idp-two.example.com', clientId: CLIENT_ID, displayName: 'Platform IdP', actor: 'agent' }),
      });
      expect(denied.status).toBe(401);
    }
  });

  afterAll(async () => {
    try {
      await browser?.close();
      await new Promise<void>((resolve) => (idpServer ? idpServer.close(() => resolve()) : resolve()));
      if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
      await app?.close();
      setSafeFetchForTests(null);
      Object.assign(config as { publicBaseUrl: string; jwtIssuer: string }, savedConfig);
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      await sql?.end();
    } finally {
      // Rows need no cleanup: the whole database goes, even if a step above threw.
      await dropTestDatabase?.();
    }
  });

  it('request, step-up sign-in and approval in the browser, consume in enforce(): allowed once, replay refused', async () => {
    const caseId = newCase();
    const request = await createRequest(caseId, 'approve');
    expect(request.approvalPage).toBe(`${base}/decisions/${request.requestId}`);
    expect(request.approvalsRequired).toBe(1);
    const grantToken = await agentGrantToken();

    // Without a decision grant the tool call is refused.
    expect(await enforceTs(grantToken, caseId, 'approve')).toMatchObject({ allowed: false, reasonCode: 'decision_required' });

    const context = await newContext();
    const page = await context.newPage();

    // A password alone is not strong enough.
    await signIn(page, request.approvalPage, 'approver-a', 'pwd');
    await page.getByRole('heading', { name: 'Stronger sign-in required' }).waitFor();
    expect((await context.cookies(base)).some((c) => c.name === SESSION_COOKIE)).toBe(false);

    // Step up with a security key.
    await signIn(page, request.approvalPage, 'approver-a', 'hwk');
    await page.waitForURL(request.approvalPage);
    const session = (await context.cookies(base)).find((c) => c.name === SESSION_COOKIE);
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
    // The token endpoint was called with the PKCE verifier by the service, never by the browser.
    expect(provider.tokenRequests.at(-1)?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // The page shows the exact action, the memo and the policy score with their hashes.
    const text = await page.locator('body').innerText();
    expect(text).toContain(caseId);
    expect(text).toContain(request.actionHash);
    expect(text).toContain('Registry record active; owners reconcile. Proposed: approve.');
    expect(text).toContain('"tier": "low"');
    await page.screenshot({ path: join(SCREENSHOTS, 'review.png'), fullPage: true });

    const post = page.waitForRequest((r) => r.method() === 'POST' && r.url() === request.approvalPage);
    await approveOnPage(page, 'approve');
    // The browser's own form post carries the headers the service requires.
    expect(await (await post).allHeaders()).toMatchObject({ origin: base, 'sec-fetch-site': 'same-origin' });
    await page.getByRole('heading', { name: 'Approved' }).waitFor();
    await page.screenshot({ path: join(SCREENSHOTS, 'approved.png'), fullPage: true });
    await context.close();

    const grants = await grantsFor(request.requestId);
    expect(grants).toHaveLength(1);

    // The agent's call carries the decision grant: verified and consumed by enforce().
    const allowed = await enforceTs(grantToken, caseId, 'approve', grants);
    expect(allowed.allowed, allowed.reason).toBe(true);
    expect(allowed.decision?.jtis).toHaveLength(1);

    // Replay of the consumed grant is refused, and so is the grant for another decision.
    expect(await enforceTs(grantToken, caseId, 'approve', grants)).toMatchObject({ allowed: false, reasonCode: 'decision_invalid', subReason: 'consumed' });
    expect(await enforceTs(grantToken, caseId, 'decline', grants)).toMatchObject({ allowed: false, reasonCode: 'decision_invalid', subReason: 'action_mismatch' });

    const [row] = await sql<{ dwell_ms: number; dwell_source: string; consumed_at: Date | null }[]>`
      SELECT dwell_ms, dwell_source, consumed_at FROM decision_grants WHERE request_id = ${request.requestId}`;
    expect(row).toMatchObject({ dwell_source: 'server' });
    expect(row!.dwell_ms).toBeGreaterThanOrEqual(2_000);
    expect(row!.consumed_at).not.toBeNull();
  }, 120_000);

  it('four eyes: the same approver cannot approve twice, a second person completes it, then one call is allowed', async () => {
    const caseId = newCase();
    const request = await createRequest(caseId, 'decline');
    expect(request.approvalsRequired).toBe(2);
    const grantToken = await agentGrantToken();

    const first = await newContext();
    const tab1 = await first.newPage();
    await signIn(tab1, request.approvalPage, 'approver-a', 'hwk');
    await tab1.waitForURL(request.approvalPage);
    const tab2 = await first.newPage();
    await tab2.goto(request.approvalPage);
    await tab2.getByRole('button', { name: 'Approve: decline' }).waitFor();

    await approveOnPage(tab1, 'decline');
    await tab1.getByText('needs one more approval from a different person').waitFor();

    // The same person submitting the form still open in another tab is refused by the service.
    await tab2.waitForTimeout(500);
    await tab2.getByRole('button', { name: 'Approve: decline' }).click();
    await tab2.getByRole('heading', { name: 'Not approved' }).waitFor();
    await tab2.getByText('It needs a different second approver').waitFor();
    await tab2.screenshot({ path: join(SCREENSHOTS, 'same-approver-refused.png'), fullPage: true });
    await first.close();

    // Signing in again in a new browser as the same person does not offer approval.
    const again = await newContext();
    const retry = await again.newPage();
    await signIn(retry, request.approvalPage, 'approver-a', 'hwk');
    await retry.waitForURL(request.approvalPage);
    await retry.getByRole('heading', { name: 'Review and approve this decision' }).waitFor();
    await retry.getByText('You have already approved this decision').waitFor();
    expect(await retry.getByRole('button', { name: 'Approve: decline' }).count()).toBe(0);
    await again.close();

    // One approval is not enough: no grants are released and the call is refused.
    expect(await grantsFor(request.requestId)).toEqual([]);
    expect(await enforceTs(grantToken, caseId, 'decline')).toMatchObject({ allowed: false, reasonCode: 'decision_required' });
    const approvals = await sql`SELECT count(*)::int AS n FROM decision_grants WHERE request_id = ${request.requestId}`;
    expect(approvals[0]!['n']).toBe(1);

    // A different person approves.
    const second = await newContext();
    const other = await second.newPage();
    await signIn(other, request.approvalPage, 'approver-b', 'hwk');
    await other.waitForURL(request.approvalPage);
    await approveOnPage(other, 'decline');
    await other.getByRole('heading', { name: 'Approved' }).waitFor();
    await second.close();

    const grants = await grantsFor(request.requestId);
    expect(grants).toHaveLength(2);
    // Presenting only one of the two grants is refused offline, before consumption.
    expect(await enforceTs(grantToken, caseId, 'decline', [grants[0]!])).toMatchObject({ allowed: false, subReason: 'four_eyes_incomplete' });
    const allowed = await enforceTs(grantToken, caseId, 'decline', grants);
    expect(allowed.allowed, allowed.reason).toBe(true);
    expect(allowed.decision?.jtis).toHaveLength(2);
    expect(await enforceTs(grantToken, caseId, 'decline', grants)).toMatchObject({ allowed: false, subReason: 'consumed' });
  }, 150_000);

  it.skipIf(!python)('the Python SDK enforce() consumes a browser-approved grant once', async () => {
    const caseId = newCase();
    const request = await createRequest(caseId, 'approve');
    const context = await newContext();
    const page = await context.newPage();
    await signIn(page, request.approvalPage, 'approver-c', 'hwk');
    await page.waitForURL(request.approvalPage);
    await approveOnPage(page, 'approve');
    await page.getByRole('heading', { name: 'Approved' }).waitFor();
    await context.close();
    const grants = await grantsFor(request.requestId);

    // Asynchronous: the auth service answers the Python SDK from this process.
    const { stdout: output } = await promisify(execFile)(python!, [join(HERE, 'python_enforce.py')], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        PYTHONPATH: join(REPO, 'packages', 'sdk-py', 'src'),
        GRANTEX_E2E_BASE_URL: base,
        GRANTEX_API_KEY: apiKey,
        GRANTEX_E2E_GRANT_TOKEN: await agentGrantToken(),
        GRANTEX_E2E_DECISION_GRANTS: grants.join(','),
        GRANTEX_E2E_ARGUMENTS: JSON.stringify(callArguments(caseId, 'approve')),
      },
    });
    const results = JSON.parse(output) as { allowed: boolean; reason_code: string; sub_reason: string }[];
    expect(results[0], JSON.stringify(results[0])).toMatchObject({ allowed: true });
    expect(results[1]).toMatchObject({ allowed: false, reason_code: 'decision_invalid', sub_reason: 'consumed' });
  }, 120_000);
});
