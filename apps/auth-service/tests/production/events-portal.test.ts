import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { Grantex } from '../../../../packages/sdk-ts/src/client.js';

describe('hosted dashboard event stream startup', () => {
  it('renders an idle subscribed stream without waiting for the heartbeat', async () => {
    const apiBase = process.env['E2E_BASE_URL'];
    const portalBase = process.env['E2E_PORTAL_BASE_URL'] ?? process.env['E2E_PUBLIC_BASE_URL'];
    if (!apiBase || !portalBase) throw new Error('E2E_BASE_URL and E2E_PUBLIC_BASE_URL are required');
    const account = await Grantex.signup({ name: `e2e-portal-events-${Date.now()}`, mode: 'sandbox' }, { baseUrl: apiBase });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${portalBase}/dashboard/login`);
      await page.getByLabel('API Key', { exact: true }).fill(account.apiKey);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL('**/dashboard');
      await page.goto(`${portalBase}/dashboard/events`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Events', exact: true }).waitFor({ timeout: 10_000 });
      await page.getByText('Live', { exact: true }).waitFor({ timeout: 10_000 });
      expect(await page.getByText('No events yet', { exact: true }).isVisible()).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
