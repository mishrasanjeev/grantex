import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import postgres from 'postgres';
import { chromium, type Browser } from 'playwright';
import { ulid } from 'ulid';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../../src/lib/webauthn.js');
vi.unmock('@simplewebauthn/server');
vi.unmock('@simplewebauthn/server/helpers');
vi.unmock('../../src/lib/events.js');
vi.unmock('../../src/lib/webhook.js');
import type { FastifyInstance } from 'fastify';
import { config } from '../../src/config.js';
import { runMigrations } from '../../src/db/migrate.js';
import { hashApiKey } from '../../src/lib/hash.js';
import { createWebAuthnEvidence, verifyPortableWebAuthnEvidence } from '../../src/lib/webauthn-evidence.js';
import { createTestDatabase } from '../helpers/database.js';
import { buildTestApp, sqlMock } from '../helpers.js';
import { Grantex } from '../../../../packages/sdk-ts/src/client.js';

const adminUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
if (process.env['CI'] && !adminUrl) {
  throw new Error('AUDIT_INTEGRATION_DATABASE_URL is required for passkey browser E2E in CI');
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

(adminUrl ? describe : describe.skip)('hosted passkeys and account response policy over HTTP and Postgres', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const developerId = `dev_passkey_${suffix}`;
  const agentId = `ag_passkey_${suffix}`;
  const otherAgentId = `ag_other_${suffix}`;
  const principalId = `person_${suffix}`;
  const apiKey = `gx_test_passkey_${suffix}`;
  const authRequestId = `areq_${ulid()}`;
  let sql: ReturnType<typeof postgres>;
  let dropDatabase: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let browser: Browser;
  let base = '';
  let client: Grantex;
  const originalConfig = { fidoRpId: config.fidoRpId, fidoOrigin: config.fidoOrigin };
  const originalFlags = {
    enrollment: process.env['PASSKEY_ENROLLMENT_ENABLED'],
    policy: process.env['IRREGULARITY_RESPONSE_POLICY_ENABLED'],
    cascade: process.env['IRREGULARITY_CASCADE_REVOCATION_ENABLED'],
    statusCheck: process.env['PORTABLE_WEBAUTHN_EVIDENCE_STATUS_CHECK_ENABLED'],
  };

  beforeAll(async () => {
    const database = await createTestDatabase('passkey_policy');
    dropDatabase = database.drop;
    sql = postgres(database.url, { max: 10, idle_timeout: 5, onnotice: () => {} });
    await runMigrations(sql);
    await sql`INSERT INTO developers (id, api_key_hash, name, mode)
      VALUES (${developerId}, ${hashApiKey(apiKey)}, 'Passkey E2E', 'live')`;
    await sql`INSERT INTO agents (id, did, developer_id, name, scopes)
      VALUES (${agentId}, ${`did:grantex:${agentId}`}, ${developerId}, 'Test agent', ${['read']})`;
    await sql`INSERT INTO agents (id, did, developer_id, name, scopes)
      VALUES (${otherAgentId}, ${`did:grantex:${otherAgentId}`}, ${developerId}, 'Other agent', ${['read']})`;
    await sql`INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, expires_at)
      VALUES (${authRequestId}, ${agentId}, ${principalId}, ${developerId}, ${['read']}, NOW() + INTERVAL '10 minutes')`;

    const port = await freePort();
    base = `http://localhost:${port}`;
    Object.assign(config as { fidoRpId: string; fidoOrigin: string }, { fidoRpId: 'localhost', fidoOrigin: base });
    process.env['PASSKEY_ENROLLMENT_ENABLED'] = 'true';
    process.env['IRREGULARITY_RESPONSE_POLICY_ENABLED'] = 'true';
    process.env['IRREGULARITY_CASCADE_REVOCATION_ENABLED'] = 'true';
    process.env['PORTABLE_WEBAUTHN_EVIDENCE_STATUS_CHECK_ENABLED'] = 'true';
    app = await buildTestApp();
    await app.listen({ port, host: 'localhost' });
    browser = await chromium.launch();
    client = new Grantex({ apiKey, baseUrl: base, issuer: base, maxRetries: 0 });
  }, 180_000);

  beforeEach(() => {
    sqlMock.mockImplementation(((...args: unknown[]) => (sql as unknown as (...a: unknown[]) => unknown)(...args)) as never);
    sqlMock.begin.mockImplementation(((cb: (tx: unknown) => unknown) => sql.begin(cb as never)) as never);
    sqlMock.json.mockImplementation(((value: unknown) => sql.json(value as never)) as never);
    sqlMock.unsafe.mockImplementation(((query: string, params?: unknown[]) => sql.unsafe(query, params as never)) as never);
  });

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    Object.assign(config as { fidoRpId: string; fidoOrigin: string }, originalConfig);
    if (originalFlags.enrollment === undefined) delete process.env['PASSKEY_ENROLLMENT_ENABLED'];
    else process.env['PASSKEY_ENROLLMENT_ENABLED'] = originalFlags.enrollment;
    if (originalFlags.policy === undefined) delete process.env['IRREGULARITY_RESPONSE_POLICY_ENABLED'];
    else process.env['IRREGULARITY_RESPONSE_POLICY_ENABLED'] = originalFlags.policy;
    if (originalFlags.cascade === undefined) delete process.env['IRREGULARITY_CASCADE_REVOCATION_ENABLED'];
    else process.env['IRREGULARITY_CASCADE_REVOCATION_ENABLED'] = originalFlags.cascade;
    if (originalFlags.statusCheck === undefined) delete process.env['PORTABLE_WEBAUTHN_EVIDENCE_STATUS_CHECK_ENABLED'];
    else process.env['PORTABLE_WEBAUTHN_EVIDENCE_STATUS_CHECK_ENABLED'] = originalFlags.statusCheck;
    await sql?.end();
    await dropDatabase?.();
  });

  it('registers a one-use passkey in Chromium and approves linked live consent', async () => {
    const blocked = await fetch(`${base}/v1/consent/${authRequestId}/approve`, { method: 'POST' });
    expect(blocked.status).toBe(403);

    const enrollment = await client.webauthn.createEnrollmentSession({ principalId, authRequestId });
    expect(enrollment.enrollmentUrl).toContain('#ticket=');
    const ticket = new URLSearchParams(new URL(enrollment.enrollmentUrl).hash.slice(1)).get('ticket');
    expect(ticket).toBeTruthy();
    const preflight = await fetch(`${base}/v1/webauthn/enroll/options`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    const generated = await preflight.json() as { publicKey: { rp: { id: string } } };
    expect(generated.publicKey.rp.id).toBe('localhost');

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
          hasUserVerification: true, isUserVerified: true,
        },
      });
      await page.goto(enrollment.enrollmentUrl);
      expect(page.url()).not.toContain('ticket=');
      await page.getByRole('button', { name: 'Register passkey' }).click();
      try {
        await page.waitForURL(`**/consent?req=${authRequestId}`, { timeout: 20_000 });
      } catch (error) {
        throw new Error(`enrollment did not return to consent: ${await page.locator('#status').textContent()}`, { cause: error });
      }
      const credentials = await sql`SELECT id FROM webauthn_credentials
        WHERE developer_id = ${developerId} AND principal_id = ${principalId}`;
      expect(credentials).toHaveLength(1);

      const replay = await fetch(`${base}/v1/webauthn/enroll/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
      });
      expect(replay.status).toBe(400);

      await page.getByRole('button', { name: 'Approve' }).click();
      await page.getByRole('heading', { name: 'Approved' }).waitFor({ timeout: 20_000 });
      const approved = await sql`SELECT status, code, fido_verified, fido_evidence FROM auth_requests WHERE id = ${authRequestId}`;
      expect(approved[0]).toMatchObject({ status: 'approved', fido_verified: true });
      const evidence = approved[0]?.['fido_evidence'];
      expect(await verifyPortableWebAuthnEvidence(evidence, { rpId: 'localhost', origin: base })).toBe(true);
      expect(await verifyPortableWebAuthnEvidence(evidence, { rpId: 'other.example', origin: base })).toBe(false);

      const exchanged = await fetch(`${base}/v1/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: approved[0]?.['code'], agentId, credentialFormat: 'vc-jwt' }),
      });
      expect(exchanged.status, await exchanged.clone().text()).toBe(201);
      const issued = await exchanged.json() as {
        grantToken: string; verifiableCredential: string; refreshToken: string; grantId: string;
      };
      expect(issued.verifiableCredential).toBeTruthy();
      const grantClaim = decodeJwt(issued.grantToken)['urn:grantex:grant'] as Record<string, unknown>;
      const summary = grantClaim['webauthn'] as Record<string, unknown>;
      const vc = decodeJwt(issued.verifiableCredential)['vc'] as Record<string, unknown>;
      const vcEvidence = (vc['evidence'] as Record<string, unknown>[])[0]!;
      expect(summary['digest']).toBe(vcEvidence['digest']);
      expect(summary['authRequestId']).toBe(authRequestId);
      expect(summary['userVerified']).toBe(true);
      expect(vcEvidence['type']).toBe('GrantexWebAuthnAssertion');
      expect(vcEvidence['credentialPublicKey']).toBeTruthy();
      expect(await verifyPortableWebAuthnEvidence(vcEvidence, { rpId: 'localhost', origin: base })).toBe(true);
      expect(await verifyPortableWebAuthnEvidence({ ...vcEvidence, signature: 'forged' }, { rpId: 'localhost', origin: base })).toBe(false);
      const storedGrant = await sql`SELECT fido_verified, fido_credential_id, fido_evidence
        FROM grants WHERE id = ${issued.grantId}`;
      expect(storedGrant[0]?.['fido_verified']).toBe(true);
      expect(storedGrant[0]?.['fido_credential_id']).toBe(vcEvidence['credentialId']);
      expect((storedGrant[0]?.['fido_evidence'] as Record<string, unknown>)['digest']).toBe(summary['digest']);
      const grantResponse = await fetch(`${base}/v1/grants/${issued.grantId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(grantResponse.status).toBe(200);
      expect((await grantResponse.json() as { webauthnEvidence: Record<string, unknown> }).webauthnEvidence)
        .toEqual(summary);

      const refreshed = await fetch(`${base}/v1/token/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: issued.refreshToken, agentId }),
      });
      expect(refreshed.status, await refreshed.clone().text()).toBe(201);
      const next = await refreshed.json() as { grantToken: string };
      expect((decodeJwt(next.grantToken)['urn:grantex:grant'] as Record<string, unknown>)['webauthn'])
        .toEqual(summary);

      const delegated = await fetch(`${base}/v1/grants/delegate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentGrantToken: issued.grantToken, subAgentId: otherAgentId,
          scopes: ['read'], credentialFormat: 'vc-jwt',
        }),
      });
      expect(delegated.status, await delegated.clone().text()).toBe(201);
      const child = await delegated.json() as {
        grantToken: string; refreshToken: string; verifiableCredential: string; grantId: string;
      };
      expect((decodeJwt(child.grantToken)['urn:grantex:grant'] as Record<string, unknown>)['webauthn'])
        .toEqual(summary);
      const childVc = decodeJwt(child.verifiableCredential)['vc'] as Record<string, unknown>;
      expect((childVc['evidence'] as Record<string, unknown>[])[0]?.['digest']).toBe(summary['digest']);
      expect((await sql`SELECT fido_evidence FROM grants WHERE id = ${child.grantId}`)[0]?.['fido_evidence'])
        .toMatchObject({ digest: summary['digest'] });
      const childRefresh = await fetch(`${base}/v1/token/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: child.refreshToken, agentId: otherAgentId }),
      });
      expect(childRefresh.status, await childRefresh.clone().text()).toBe(201);
      const refreshedChild = await childRefresh.json() as { grantToken: string };
      const refreshedChildClaim = decodeJwt(refreshedChild.grantToken)['urn:grantex:grant'] as Record<string, unknown>;
      expect(refreshedChildClaim['webauthn']).toEqual(summary);
      const childVerified = await fetch(`${base}/v1/credentials/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: child.verifiableCredential }),
      });
      expect(await childVerified.json()).toMatchObject({ valid: true, webauthnVerified: true });

      const verifyVc = () => fetch(`${base}/v1/credentials/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: issued.verifiableCredential }),
      });
      expect(await (await verifyVc()).json()).toMatchObject({ valid: true, webauthnVerified: true });
      const [priorStatus] = await sql<{ status_list_id: string; encoded_list: string }[]>`
        SELECT credential.status_list_id, list.encoded_list
        FROM verifiable_credentials credential
        JOIN vc_status_lists list ON list.id = credential.status_list_id
        WHERE credential.grant_id = ${issued.grantId}
      `;
      const revoked = await fetch(`${base}/v1/grants/${issued.grantId}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` },
      });
      expect(revoked.status).toBe(204);
      expect(await (await verifyVc()).json()).toMatchObject({ valid: false, revoked: true });
      const revokedChild = await fetch(`${base}/v1/credentials/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: child.verifiableCredential }),
      });
      expect(await revokedChild.json()).toMatchObject({ valid: false, revoked: true });

      // Historical direct grant revocations may have left the VC row and list bit active.
      await sql`UPDATE verifiable_credentials SET status = 'active', revoked_at = NULL
        WHERE grant_id = ${issued.grantId}`;
      await sql`UPDATE vc_status_lists SET encoded_list = ${priorStatus!.encoded_list}
        WHERE id = ${priorStatus!.status_list_id}`;
      expect(await (await verifyVc()).json()).toMatchObject({ valid: false, revoked: true });
      await sql`UPDATE grants SET status = 'active', revoked_at = NULL WHERE id = ${child.grantId}`;
      await sql`UPDATE verifiable_credentials SET status = 'active', revoked_at = NULL
        WHERE grant_id = ${child.grantId}`;
      const staleChild = await fetch(`${base}/v1/credentials/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: child.verifiableCredential }),
      });
      expect(await staleChild.json()).toMatchObject({ valid: false, revoked: true });

      await sql`UPDATE grants SET status = 'active', revoked_at = NULL,
        parent_grant_id = ${child.grantId} WHERE id = ${issued.grantId}`;
      const cyclic = await fetch(`${base}/v1/credentials/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: issued.verifiableCredential }),
      });
      expect(await cyclic.json()).toMatchObject({ valid: false, revoked: true });

      process.env['PORTABLE_WEBAUTHN_EVIDENCE_STATUS_CHECK_ENABLED'] = 'false';
      expect(await (await verifyVc()).json()).toMatchObject({ valid: true, webauthnVerified: true });
      process.env['PORTABLE_WEBAUTHN_EVIDENCE_STATUS_CHECK_ENABLED'] = 'true';
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW(),
        parent_grant_id = NULL WHERE id = ${issued.grantId}`;
      await sql`UPDATE grants SET status = 'revoked', revoked_at = NOW()
        WHERE id = ${child.grantId}`;
    } finally {
      await context.close();
    }
  }, 60_000);

  it.each(['Approve', 'Deny'] as const)('verifies an interactively selected principal before %s', async (action) => {
    const selectedPrincipal = `selected_${action}_${suffix}`;
    const requestId = `areq_${ulid()}`;
    await sql`INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, expires_at, protocol)
      VALUES (${requestId}, ${agentId}, '', ${developerId}, ${['read']},
        NOW() + INTERVAL '10 minutes', 'oauth-agent-grants-03')`;
    const enrollment = await client.webauthn.createEnrollmentSession({ principalId: selectedPrincipal });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
          hasUserVerification: true, isUserVerified: true,
        },
      });
      await page.goto(enrollment.enrollmentUrl);
      await page.getByRole('button', { name: 'Register passkey' }).click();
      await page.getByText('Passkey registered.', { exact: true }).waitFor({ timeout: 20_000 });
      await page.goto(`${base}/consent?req=${requestId}`);
      await page.getByLabel('Principal identifier').fill(selectedPrincipal);
      await page.getByRole('button', { name: action, exact: true }).click();
      await page.getByRole('heading', { name: action === 'Approve' ? 'Approved' : 'Denied' })
        .waitFor({ timeout: 20_000 });
      const [request] = await sql`SELECT principal_id, fido_verified, status
        FROM auth_requests WHERE id = ${requestId}`;
      expect(request).toMatchObject({
        principal_id: selectedPrincipal, fido_verified: true,
        status: action === 'Approve' ? 'approved' : 'denied',
      });
    } finally {
      await context.close();
    }
  });

  it('runs sandbox passkey-required consent without an auto-approval or developer-key bypass', async () => {
    const dev = `dev_sandbox_${suffix}`;
    const key = `gx_test_sandbox_${suffix}`;
    const sandboxAgent = `ag_sandbox_${suffix}`;
    const person = `sandbox_person_${suffix}`;
    await sql`INSERT INTO developers (id, api_key_hash, name, mode)
      VALUES (${dev}, ${hashApiKey(key)}, 'Sandbox passkey E2E', 'sandbox')`;
    await sql`INSERT INTO agents (id, did, developer_id, name, scopes)
      VALUES (${sandboxAgent}, ${`did:grantex:${sandboxAgent}`}, ${dev}, 'Sandbox agent', ${['read']})`;
    const sandbox = new Grantex({ apiKey: key, baseUrl: base, issuer: base, maxRetries: 0 });
    expect(await sandbox.authorize({ agentId: sandboxAgent, userId: person, scopes: ['read'] }))
      .toHaveProperty('code');
    await sandbox.updateSettings({ fidoRequired: true });
    const pending = await sandbox.authorize({ agentId: sandboxAgent, userId: person, scopes: ['read'] });
    expect(pending).not.toHaveProperty('code');
    for (const action of ['approve', 'deny']) {
      const bypass = await fetch(`${base}/v1/authorize/${pending.authRequestId}/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` },
      });
      expect(bypass.status).toBe(403);
    }
    const unverified = await fetch(`${base}/v1/consent/${pending.authRequestId}/approve`, { method: 'POST' });
    expect(unverified.status).toBe(403);
    const enrollment = await sandbox.webauthn.createEnrollmentSession({
      principalId: person, authRequestId: pending.authRequestId,
    });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
          hasUserVerification: true, isUserVerified: true,
        },
      });
      await page.goto(enrollment.enrollmentUrl);
      await page.getByRole('button', { name: 'Register passkey' }).click();
      await page.waitForURL(`**/consent?req=${pending.authRequestId}`);
      const approved = page.waitForResponse((response) =>
        response.url().endsWith(`/v1/consent/${pending.authRequestId}/approve`)
        && response.status() === 200);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      const { code } = await (await approved).json() as { code: string };
      const token = await sandbox.tokens.exchange({ code, agentId: sandboxAgent, credentialFormat: 'vc-jwt' });
      const evidence = (decodeJwt(token.grantToken)['urn:grantex:grant'] as Record<string, unknown>)['webauthn'];
      expect(evidence).toMatchObject({ userVerified: true, origin: base });
      expect(token.verifiableCredential).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  it('refuses legacy or mismatched evidence on a live authorization code', async () => {
    const code = `code_${ulid()}`;
    const missingId = `areq_${ulid()}`;
    await sql`INSERT INTO auth_requests
      (id, agent_id, principal_id, developer_id, scopes, expires_at, status, code, fido_verified)
      VALUES (${missingId}, ${agentId}, ${principalId}, ${developerId}, ${['read']},
        NOW() + INTERVAL '10 minutes', 'approved', ${code}, TRUE)`;
    const exchange = (authorizationCode: string) => fetch(`${base}/v1/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authorizationCode, agentId, credentialFormat: 'vc-jwt' }),
    });
    const missing = await exchange(code);
    expect(missing.status).toBe(400);
    expect((await missing.json() as { code: string }).code).toBe('PASSKEY_EVIDENCE_REQUIRED');
    expect((await sql`SELECT status FROM auth_requests WHERE id = ${missingId}`)[0]?.['status']).toBe('approved');

    const oldEvidence = createWebAuthnEvidence({
      authRequestId: missingId, credentialId: 'old-credential', credentialPublicKey: 'AQIDBA',
      previousCounter: 0, rpId: 'localhost', origin: base, challenge: 'old-challenge',
      clientDataJSON: 'old-client', authenticatorData: 'old-authenticator',
      signature: 'old-signature', userVerified: true, assertedAt: new Date().toISOString(),
    });
    const copiedId = `areq_${ulid()}`;
    const copiedCode = `code_${ulid()}`;
    await sql`INSERT INTO auth_requests
      (id, agent_id, principal_id, developer_id, scopes, expires_at, status, code, fido_verified, fido_evidence)
      VALUES (${copiedId}, ${agentId}, ${principalId}, ${developerId}, ${['read']},
        NOW() + INTERVAL '10 minutes', 'approved', ${copiedCode}, TRUE, ${sql.json(oldEvidence as never)})`;
    const copied = await exchange(copiedCode);
    expect(copied.status).toBe(500);
    expect((await sql`SELECT status FROM auth_requests WHERE id = ${copiedId}`)[0]?.['status']).toBe('approved');
  });

  it('shows missing, invalid and expired enrollment-link errors in Chromium', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    try {
      const page = await context.newPage();
      await page.goto(`${base}/passkey-enroll`);
      expect(await page.getByRole('button', { name: 'Register passkey' }).isDisabled()).toBe(true);
      expect(await page.getByRole('status').textContent()).toContain('fresh enrollment link');
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path: 'test-results/passkey-missing-link-mobile.png' });

      const invalidPage = await context.newPage();
      await invalidPage.goto(`${base}/passkey-enroll#ticket=invalid`);
      await invalidPage.waitForURL(`${base}/passkey-enroll`);
      await invalidPage.getByRole('button', { name: 'Register passkey' }).click();
      await invalidPage.getByText('Enrollment link is invalid or expired').waitFor();

      const expiredPrincipal = `person_expired_${suffix}`;
      const enrollment = await client.webauthn.createEnrollmentSession({ principalId: expiredPrincipal });
      const ticketId = new URLSearchParams(new URL(enrollment.enrollmentUrl).hash.slice(1))
        .get('ticket')?.split('.')[0];
      expect(ticketId).toBeTruthy();
      await sql`UPDATE webauthn_challenges SET expires_at = NOW() - INTERVAL '1 second'
        WHERE id = ${ticketId!}`;
      const expiredPage = await context.newPage();
      await expiredPage.goto(enrollment.enrollmentUrl);
      await expiredPage.getByRole('button', { name: 'Register passkey' }).click();
      await expiredPage.getByText('Enrollment link is invalid or expired').waitFor();
      expect((await client.webauthn.listCredentials(expiredPrincipal)).credentials).toHaveLength(0);
    } finally {
      await context.close();
    }
  }, 60_000);

  it('registers two devices, lists and deletes them, then blocks consent without a passkey', async () => {
    const multiPrincipal = `person_multi_${suffix}`;
    const contexts = [] as Awaited<ReturnType<Browser['newContext']>>[];
    try {
      for (let device = 0; device < 2; device++) {
        const enrollment = await client.webauthn.createEnrollmentSession({ principalId: multiPrincipal });
        const context = await browser.newContext();
        contexts.push(context);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('WebAuthn.enable');
        await cdp.send('WebAuthn.addVirtualAuthenticator', {
          options: {
            protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
            hasUserVerification: true, isUserVerified: true,
          },
        });
        await page.goto(enrollment.enrollmentUrl);
        await page.getByRole('button', { name: 'Register passkey' }).click();
        await page.getByText('Passkey registered.', { exact: true }).waitFor({ timeout: 20_000 });
        expect(page.url()).toBe(`${base}/passkey-enroll`);
        expect((await client.webauthn.listCredentials(multiPrincipal)).credentials).toHaveLength(device + 1);
        if (device === 0) {
          await mkdir('test-results', { recursive: true });
          await page.screenshot({ path: 'test-results/passkey-registered.png' });
        }
      }

      const { credentials } = await client.webauthn.listCredentials(multiPrincipal);
      expect(new Set(credentials.map((credential) => credential.id)).size).toBe(2);
      await client.webauthn.deleteCredential(credentials[0]!.id);
      expect((await client.webauthn.listCredentials(multiPrincipal)).credentials).toHaveLength(1);
      await client.webauthn.deleteCredential(credentials[1]!.id);
      expect((await client.webauthn.listCredentials(multiPrincipal)).credentials).toHaveLength(0);

      const pendingRequestId = `areq_${ulid()}`;
      await sql`INSERT INTO auth_requests (id, agent_id, principal_id, developer_id, scopes, expires_at)
        VALUES (${pendingRequestId}, ${agentId}, ${multiPrincipal}, ${developerId}, ${['read']}, NOW() + INTERVAL '10 minutes')`;
      const assertion = await fetch(`${base}/v1/webauthn/assert/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authRequestId: pendingRequestId, principalId: multiPrincipal }),
      });
      expect(assertion.status).toBe(400);
      const approval = await fetch(`${base}/v1/consent/${pendingRequestId}/approve`, { method: 'POST' });
      expect(approval.status).toBe(403);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  }, 90_000);

  it('retains grants in alert-only mode and revokes only the finding agent in revoke mode', async () => {
    const grantOne = `grnt_passkey_${suffix}`;
    const grantTwo = `grnt_other_${suffix}`;
    await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
      VALUES (${grantOne}, ${agentId}, ${principalId}, ${developerId}, ${['read']}, NOW() + INTERVAL '1 day')`;
    await sql`INSERT INTO grants (id, agent_id, principal_id, developer_id, scopes, expires_at)
      VALUES (${grantTwo}, ${otherAgentId}, ${principalId}, ${developerId}, ${['read']}, NOW() + INTERVAL '1 day')`;
    await sql`INSERT INTO audit_entries
      (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, hash, timestamp)
      SELECT ${`aud_passkey_${suffix}_`} || n::text, ${agentId}, ${`did:grantex:${agentId}`},
        ${grantOne}, ${principalId}, ${developerId}, 'read', ${'a'.repeat(64)}, NOW()
      FROM generate_series(1, 51) AS n`;
    await sql`INSERT INTO webhooks (id, developer_id, url, events, secret)
      VALUES (${`wh_passkey_${suffix}`}, ${developerId}, 'https://example.com/webhook',
        ${['anomaly.detected']}, 'test-secret')`;

    expect((await client.anomalies.setResponsePolicy('alert_only')).mode).toBe('alert_only');
    const alerted = await client.anomalies.detect();
    expect(alerted.responseMode).toBe('alert_only');
    expect(alerted.autoRevokedGrants).toBe(0);
    const deliveries = await sql`SELECT event_type, payload FROM webhook_deliveries
      WHERE developer_id = ${developerId} AND event_type = 'anomaly.detected'`;
    expect(deliveries.length).toBeGreaterThan(0);
    const event = JSON.parse(deliveries[0]?.['payload'] as string) as { data: { severity: string } };
    expect(event.data.severity).toBe('high');
    expect((await sql`SELECT status FROM grants WHERE id = ${grantOne}`)[0]?.status).toBe('active');

    expect((await client.anomalies.setResponsePolicy('revoke_agent_grants')).mode).toBe('revoke_agent_grants');
    const revoked = await client.anomalies.detect();
    expect(revoked.autoRevokedGrants).toBe(1);
    expect((await sql`SELECT status FROM grants WHERE id = ${grantOne}`)[0]?.status).toBe('revoked');
    expect((await sql`SELECT status FROM grants WHERE id = ${grantTwo}`)[0]?.status).toBe('active');
    const changes = await sql`SELECT previous_mode, next_mode FROM irregularity_policy_changes
      WHERE developer_id = ${developerId} ORDER BY changed_at, id`;
    expect(changes).toHaveLength(2);
    expect(changes.map((row) => row['next_mode'])).toEqual(['alert_only', 'revoke_agent_grants']);
  }, 60_000);
});
