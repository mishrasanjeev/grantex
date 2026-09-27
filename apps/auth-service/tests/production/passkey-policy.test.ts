import { chromium } from 'playwright';
import { gunzipSync } from 'node:zlib';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { Grantex } from '../../../../packages/sdk-ts/src/client.js';
import { verifyPortableWebAuthnEvidence } from '../../src/lib/webauthn-evidence.js';

const apiBase = process.env['E2E_BASE_URL'];
const publicBase = process.env['E2E_PUBLIC_BASE_URL'];

describe('production passkey enrollment and account response policy', () => {
  it('registers a passkey, approves live consent, then exercises both response modes', async () => {
    if (!apiBase || !publicBase) {
      throw new Error('E2E_BASE_URL and E2E_PUBLIC_BASE_URL are required');
    }

    const account = await Grantex.signup(
      { name: `e2e-passkey-${Date.now()}`, mode: 'live' },
      { baseUrl: apiBase },
    );
    const client = new Grantex({ apiKey: account.apiKey, baseUrl: apiBase, issuer: publicBase });
    const agent = await client.agents.register({
      name: 'Passkey production E2E', description: 'Isolated production consent and policy check',
      scopes: ['calendar:read'],
    });
    const principalId = `e2e-passkey-principal-${Date.now()}`;
    const auth = await client.authorize({ agentId: agent.agentId, userId: principalId, scopes: ['calendar:read'] });
    expect(auth.consentUrl).toMatch(/^https:\/\//);
    expect('code' in auth).toBe(false);

    const enrollment = await client.webauthn.createEnrollmentSession({
      principalId,
      authRequestId: auth.authRequestId,
    });
    const enrollmentUrl = new URL(enrollment.enrollmentUrl);
    expect(enrollmentUrl.origin).toBe(new URL(publicBase).origin);
    expect(enrollmentUrl.pathname).toBe('/passkey-enroll');
    expect(enrollmentUrl.hash).toMatch(/^#ticket=/);

    const browser = await chromium.launch();
    let code = '';
    try {
      const context = await browser.newContext();
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
      await page.waitForURL(`**/consent?req=${auth.authRequestId}`);
      const approval = page.waitForResponse((response) =>
        response.url().endsWith(`/v1/consent/${auth.authRequestId}/approve`)
        && response.request().method() === 'POST'
        && response.status() === 200);
      await page.getByRole('button', { name: 'Approve' }).click();
      const approved = await approval;
      const approvalBody = (await approved.json()) as { code?: string; message?: string };
      expect(approved.status(), approvalBody.message).toBe(200);
      code = approvalBody.code ?? '';
      expect(code).toBeTruthy();
      await page.getByRole('heading', { name: 'Approved' }).waitFor();
      await context.close();
    } finally {
      await browser.close();
    }

    const token = await client.tokens.exchange({
      code, agentId: agent.agentId, credentialFormat: 'vc-jwt',
    });
    expect(token.verifiableCredential).toBeTruthy();
    const grantClaim = decodeJwt(token.grantToken)['urn:grantex:grant'] as Record<string, unknown>;
    const evidenceRef = grantClaim['webauthn'] as Record<string, unknown>;
    const vc = decodeJwt(token.verifiableCredential!)['vc'] as Record<string, unknown>;
    const assertion = (vc['evidence'] as Record<string, unknown>[])[0]!;
    const credentialStatus = vc['credentialStatus'] as Record<string, unknown>;
    const statusListUrl = credentialStatus['statusListCredential'] as string;
    const statusIndex = Number(credentialStatus['statusListIndex']);
    expect(new URL(statusListUrl).origin).toBe(new URL(publicBase).origin);
    expect(Number.isInteger(statusIndex)).toBe(true);
    const isRevokedInPublicList = async () => {
      const response = await fetch(statusListUrl);
      expect(response.status).toBe(200);
      const list = await response.json() as { credentialSubject: { encodedList: string } };
      const bits = gunzipSync(Buffer.from(list.credentialSubject.encodedList, 'base64url'));
      return ((bits[Math.floor(statusIndex / 8)]! >> (7 - statusIndex % 8)) & 1) === 1;
    };
    expect(evidenceRef).toMatchObject({
      type: 'GrantexWebAuthnAssertion', rpId: 'grantex.dev',
      origin: new URL(publicBase).origin, userVerified: true,
    });
    expect(evidenceRef['digest']).toBe(assertion['digest']);
    expect(assertion['credentialPublicKey']).toBeTruthy();
    expect(await verifyPortableWebAuthnEvidence(assertion, {
      rpId: 'grantex.dev', origin: new URL(publicBase).origin,
    })).toBe(true);
    expect(await verifyPortableWebAuthnEvidence({ ...assertion, signature: 'forged' }, {
      rpId: 'grantex.dev', origin: new URL(publicBase).origin,
    })).toBe(false);
    const grant = await client.grants.get(token.grantId);
    expect(grant.status).toBe('active');
    expect(grant.webauthnEvidence).toEqual(evidenceRef);
    expect(grant.webauthnEvidence).not.toHaveProperty('credentialPublicKey');

    const verifyVc = (credential: string) => fetch(`${apiBase}/v1/credentials/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    expect(await (await verifyVc(token.verifiableCredential!)).json())
      .toMatchObject({ valid: true, webauthnVerified: true });
    expect(await isRevokedInPublicList()).toBe(false);

    const refreshed = await client.tokens.refresh({
      refreshToken: token.refreshToken, agentId: agent.agentId,
    });
    expect((decodeJwt(refreshed.grantToken)['urn:grantex:grant'] as Record<string, unknown>)['webauthn'])
      .toEqual(evidenceRef);

    const childAgent = await client.agents.register({
      name: 'Passkey production delegated E2E',
      description: 'Isolated portable assertion delegation check',
      scopes: ['calendar:read'],
    });
    const delegated = await fetch(`${apiBase}/v1/grants/delegate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentGrantToken: token.grantToken, subAgentId: childAgent.agentId,
        scopes: ['calendar:read'], credentialFormat: 'vc-jwt',
      }),
    });
    expect(delegated.status, await delegated.clone().text()).toBe(201);
    const child = await delegated.json() as { grantId: string; grantToken: string; verifiableCredential: string };
    expect((decodeJwt(child.grantToken)['urn:grantex:grant'] as Record<string, unknown>)['webauthn'])
      .toEqual(evidenceRef);
    expect(await (await verifyVc(child.verifiableCredential)).json())
      .toMatchObject({ valid: true, webauthnVerified: true });

    expect((await client.anomalies.getResponsePolicy()).mode).toBe('revoke_agent_grants');
    expect((await client.anomalies.setResponsePolicy('alert_only')).mode).toBe('alert_only');
    expect((await client.anomalies.getResponsePolicy()).mode).toBe('alert_only');

    // /v1/audit/log is limited to 30 requests per minute. Keep this production
    // check below that limit while creating a genuine high-severity rate spike.
    for (let index = 0; index < 26; index++) {
      await client.audit.log({
        agentId: agent.agentId, agentDid: agent.did, grantId: token.grantId,
        principalId, action: 'e2e.passkey.policy.read', metadata: { index },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    for (let index = 26; index < 51; index++) {
      await client.audit.log({
        agentId: agent.agentId, agentDid: agent.did, grantId: token.grantId,
        principalId, action: 'e2e.passkey.policy.read', metadata: { index },
      });
    }

    const alertOnly = await client.anomalies.detect();
    expect(alertOnly.responseMode).toBe('alert_only');
    expect(alertOnly.anomalies.some((item) => item.type === 'rate_spike' && item.agentId === agent.agentId)).toBe(true);
    expect(alertOnly.autoRevokedGrants).toBe(0);
    expect((await client.grants.get(token.grantId)).status).toBe('active');

    expect((await client.anomalies.setResponsePolicy('revoke_agent_grants')).mode).toBe('revoke_agent_grants');
    const revoke = await client.anomalies.detect();
    expect(revoke.autoRevokedGrants).toBeGreaterThan(0);
    expect((await client.grants.get(token.grantId)).status).toBe('revoked');
    expect((await client.grants.get(child.grantId)).status).toBe('revoked');
    expect(await (await verifyVc(token.verifiableCredential!)).json())
      .toMatchObject({ valid: false, revoked: true });
    expect(await (await verifyVc(child.verifiableCredential)).json())
      .toMatchObject({ valid: false, revoked: true });
    expect(await isRevokedInPublicList()).toBe(true);
  });
});
