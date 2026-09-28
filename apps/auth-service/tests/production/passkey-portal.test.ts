import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { Grantex } from '../../../../packages/sdk-ts/src/client.js';

describe('hosted dashboard passkey management', () => {
  it('issues an enrollment link, lists the registered passkey and confirms removal', async () => {
    const apiBase = process.env['E2E_BASE_URL'];
    const portalBase = process.env['E2E_PORTAL_BASE_URL'] ?? process.env['E2E_PUBLIC_BASE_URL'];
    if (!apiBase || !portalBase) throw new Error('E2E_BASE_URL and E2E_PUBLIC_BASE_URL are required');
    const account = await Grantex.signup({ name: `e2e-portal-passkey-${Date.now()}`, mode: 'live' }, { baseUrl: apiBase });
    const client = new Grantex({ apiKey: account.apiKey, baseUrl: apiBase });
    const principalId = `e2e-portal-principal-${Date.now()}`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${portalBase}/dashboard/login`);
      await page.getByLabel('API Key', { exact: true }).fill(account.apiKey);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/dashboard');
      await page.goto(`${portalBase}/dashboard/webauthn`);
      await page.getByRole('heading', { name: 'Passkeys', exact: true }).waitFor();
      await page.getByLabel('Principal ID', { exact: true }).fill(principalId);
      await page.getByRole('button', { name: 'Create enrollment link', exact: true }).click();
      const link = page.getByLabel('One-use enrollment link', { exact: true });
      await link.waitFor();
      const enrollmentPage = await context.newPage();
      const cdp = await context.newCDPSession(enrollmentPage);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
          hasUserVerification: true, isUserVerified: true,
        },
      });
      await enrollmentPage.goto(await link.inputValue());
      await enrollmentPage.getByRole('button', { name: 'Register passkey', exact: true }).click();
      await enrollmentPage.getByText('Passkey registered.', { exact: true }).waitFor();
      await enrollmentPage.close();
      await page.getByRole('button', { name: 'View passkeys', exact: true }).click();
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      const deleted = page.waitForResponse((response) =>
        response.request().method() === 'DELETE' && response.url().includes('/v1/webauthn/credentials/'));
      await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
      expect((await deleted).status()).toBe(204);
      await page.getByRole('heading', { name: 'No passkeys', exact: true }).waitFor();
      expect((await client.webauthn.listCredentials(principalId)).credentials).toHaveLength(0);
      await context.close();
    } finally {
      await browser.close();
      for (const credential of (await client.webauthn.listCredentials(principalId)).credentials) {
        await client.webauthn.deleteCredential(credential.id);
      }
    }
  });
});
