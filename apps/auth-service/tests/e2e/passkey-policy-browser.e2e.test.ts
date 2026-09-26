import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { chromium, type Browser } from 'playwright';
import { ulid } from 'ulid';
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
      const approved = await sql`SELECT status, fido_verified FROM auth_requests WHERE id = ${authRequestId}`;
      expect(approved[0]).toMatchObject({ status: 'approved', fido_verified: true });
    } finally {
      await context.close();
    }
  }, 60_000);

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
