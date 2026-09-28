import { chromium, type BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import { Grantex } from '../../../../packages/sdk-ts/src/client.js';
import { generateOAuthAgentKey, OAuthAgentClient } from '../../../../packages/sdk-ts/src/oauth-agent.js';

const apiBase = process.env['E2E_BASE_URL'];
const publicBase = process.env['E2E_PUBLIC_BASE_URL'];

function endpoints() {
  if (!apiBase || !publicBase) throw new Error('E2E_BASE_URL and E2E_PUBLIC_BASE_URL are required');
  return { api: apiBase.replace(/\/$/, ''), public: publicBase.replace(/\/$/, '') };
}

async function passkeyPage(context: BrowserContext) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true,
    },
  });
  return page;
}

describe('production sandbox/live passkey parity', () => {
  it.each(['sandbox', 'live'] as const)('supports enrollment, denial, approval and device removal in %s', async (mode) => {
    const base = endpoints();
    const account = await Grantex.signup({ name: `e2e-parity-${mode}-${Date.now()}`, mode }, { baseUrl: base.api });
    const client = new Grantex({ apiKey: account.apiKey, baseUrl: base.api, issuer: base.public });
    const agent = await client.agents.register({
      name: 'Isolated passkey parity test', description: 'Disposable sandbox/live browser validation',
      scopes: ['calendar:read'],
    });
    const principalId = `e2e-parity-${Date.now()}`;
    if (mode === 'sandbox') {
      const automatic = await client.authorize({ agentId: agent.agentId, userId: principalId, scopes: ['calendar:read'] });
      expect(automatic).toHaveProperty('code');
      await client.updateSettings({ fidoRequired: true });
    } else {
      await client.updateSettings({ fidoRequired: false });
    }
    const auth = await client.authorize({ agentId: agent.agentId, userId: principalId, scopes: ['calendar:read'] });
    expect(auth).not.toHaveProperty('code');
    for (const action of ['approve', 'deny']) {
      expect((await fetch(`${base.api}/v1/authorize/${auth.authRequestId}/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${account.apiKey}` },
      })).status).toBe(403);
      expect((await fetch(`${base.api}/v1/consent/${auth.authRequestId}/${action}`, { method: 'POST' })).status).toBe(403);
    }
    const unauthenticated = await fetch(`${base.api}/v1/webauthn/enrollment-sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ principalId }),
    });
    expect(unauthenticated.status).toBe(401);
    await expect(client.webauthn.createEnrollmentSession({
      principalId: `${principalId}-wrong`, authRequestId: auth.authRequestId,
    })).rejects.toThrow();
    const enrollment = await client.webauthn.createEnrollmentSession({ principalId, authRequestId: auth.authRequestId });
    const ticket = new URLSearchParams(new URL(enrollment.enrollmentUrl).hash.slice(1)).get('ticket');
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      let page = await passkeyPage(context);
      const optionsResponse = page.waitForResponse((response) => response.url().endsWith('/v1/webauthn/enroll/options'));
      await page.goto(enrollment.enrollmentUrl);
      expect(page.url()).not.toContain('ticket=');
      await page.getByRole('button', { name: 'Register passkey' }).click();
      const options = await (await optionsResponse).json();
      expect(options.publicKey.authenticatorSelection.userVerification).toBe('required');
      await page.waitForURL(`**/consent?req=${auth.authRequestId}`);
      expect((await fetch(`${base.api}/v1/webauthn/enroll/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }),
      })).status).toBe(400);
      const firstId = (await client.webauthn.listCredentials(principalId)).credentials[0]!.id;
      const second = await client.webauthn.createEnrollmentSession({ principalId });
      // A second device needs its own authenticator; excludeCredentials blocks
      // registering the same authenticator again for this principal.
      const secondContext = await browser.newContext();
      page = await passkeyPage(secondContext);
      await page.goto(second.enrollmentUrl);
      await page.getByRole('button', { name: 'Register passkey' }).click();
      await page.getByText('Passkey registered.', { exact: true }).waitFor();
      const credentials = (await client.webauthn.listCredentials(principalId)).credentials;
      expect(credentials).toHaveLength(2);
      await client.webauthn.deleteCredential(firstId);
      expect((await client.webauthn.listCredentials(principalId)).credentials).toHaveLength(1);
      await page.goto(auth.consentUrl);
      await page.getByRole('button', { name: 'Deny', exact: true }).click();
      await page.getByRole('heading', { name: 'Denied' }).waitFor();
      expect((await fetch(`${base.api}/v1/consent/${auth.authRequestId}/approve`, { method: 'POST' })).status).toBe(410);
      const approved = await client.authorize({ agentId: agent.agentId, userId: principalId, scopes: ['calendar:read'] });
      await page.goto(approved.consentUrl);
      const approval = page.waitForResponse((response) =>
        response.url().endsWith(`/v1/consent/${approved.authRequestId}/approve`) && response.status() === 200);
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      const { code } = await (await approval).json() as { code: string };
      await page.getByRole('heading', { name: 'Approved' }).waitFor();
      const tokens = await client.tokens.exchange({ code, agentId: agent.agentId, credentialFormat: 'both' });
      expect(tokens.verifiableCredential).toBeTruthy();
      expect((await client.grants.get(tokens.grantId)).webauthnEvidence).toMatchObject({ userVerified: true });
      for (const credential of (await client.webauthn.listCredentials(principalId)).credentials) {
        await client.webauthn.deleteCredential(credential.id);
      }
      expect((await client.webauthn.listCredentials(principalId)).credentials).toHaveLength(0);
      const missing = await client.authorize({ agentId: agent.agentId, userId: principalId, scopes: ['calendar:read'] });
      expect((await fetch(`${base.api}/v1/webauthn/assert/options`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authRequestId: missing.authRequestId, principalId }),
      })).status).toBe(400);
      await client.grants.revoke(tokens.grantId);
      const status = await fetch(`${base.api}/v1/revocations/status?grantId=${encodeURIComponent(tokens.grantId)}`, {
        headers: { Authorization: `Bearer ${account.apiKey}` },
      });
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ status: 'revoked' });
      await expect(client.agents.delete(agent.agentId)).rejects.toMatchObject({
        statusCode: 409, code: 'AGENT_HAS_CREDENTIAL_HISTORY',
      });
      expect((await client.grants.get(tokens.grantId)).status).toBe('revoked');
      await secondContext.close();
      await context.close();
    } finally {
      await browser.close();
      const suspended = await fetch(`${base.api}/v1/agents/${agent.agentId}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      });
      expect(suspended.status).toBe(200);
    }
  });

  it.each(['Approve', 'Deny'] as const)('completes live OAuth principal selection and %s', async (action) => {
    const base = endpoints();
    const account = await Grantex.signup({ name: `e2e-oauth-passkey-${Date.now()}`, mode: 'live' }, { baseUrl: base.api });
    const client = new Grantex({ apiKey: account.apiKey, baseUrl: base.api, issuer: base.public });
    const key = await generateOAuthAgentKey();
    const redirectUri = 'https://client.example/passkey-e2e-callback';
    const resource = `${base.public}/oauth/resource`;
    const agent = await client.agents.register({
      name: 'Isolated OAuth passkey test', description: 'Disposable principal-selection browser validation',
      scopes: ['grantex.resource.read'],
      redirectUris: [redirectUri], resourceServers: [resource], publicJwk: key.publicJwk,
    });
    const oauth = await OAuthAgentClient.create({
      issuer: base.public, clientId: agent.agentId, redirectUri, resource,
      privateKey: key.privateKey, publicJwk: key.publicJwk,
      allowInsecureLoopback: new URL(base.public).protocol === 'http:'
        && new URL(base.public).hostname === 'localhost',
    });
    const principalId = `e2e-oauth-principal-${Date.now()}`;
    const enrollment = await client.webauthn.createEnrollmentSession({ principalId });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await passkeyPage(context);
      // The callback belongs to the test, not an external customer's service.
      await page.route(`${redirectUri}**`, (route) => route.fulfill({ status: 200, body: 'E2E callback' }));
      await page.goto(enrollment.enrollmentUrl);
      await page.getByRole('button', { name: 'Register passkey' }).click();
      await page.getByText('Passkey registered.', { exact: true }).waitFor();
      const pending = await oauth.beginAuthorization({ scopes: ['grantex.resource.read'] });
      await page.goto(pending.authorizationUrl);
      await page.getByLabel('Principal identifier').fill(principalId);
      await page.getByRole('button', { name: action, exact: true }).click();
      await page.waitForURL(`${redirectUri}**`);
      const callback = page.url();
      expect(new URL(callback).searchParams.get('state')).toBe(pending.state);
      expect(new URL(callback).searchParams.get('iss')).toBe(base.public);
      if (action === 'Approve') {
        const tokens = await oauth.completeAuthorization(callback);
        expect((await oauth.fetch(resource, tokens.access_token)).status).toBe(200);
        await oauth.revoke(tokens.access_token, 'access_token');
        expect((await oauth.fetch(resource, tokens.access_token)).status).toBe(401);
      } else {
        expect(new URL(callback).searchParams.get('error')).toBe('access_denied');
        expect(new URL(callback).searchParams.has('code')).toBe(false);
      }
      for (const credential of (await client.webauthn.listCredentials(principalId)).credentials) {
        await client.webauthn.deleteCredential(credential.id);
      }
      await context.close();
    } finally {
      await browser.close();
      await client.agents.delete(agent.agentId);
    }
  });
});
