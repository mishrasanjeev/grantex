/**
 * PRD G-7 acceptance: the consent page "renders correctly at mobile width and
 * passes an accessibility check". Runs the real server and a real Chromium
 * (Playwright), checks layout at 375 px, runs axe-core (WCAG 2.0/2.1/2.2 A
 * and AA rules), confirms the strict CSP blocks nothing the page needs, and
 * drives both form buttons through the browser so the cookie, Origin and
 * form-action handling are exercised end to end.
 *
 * Screenshots are written to test-results/ (uploaded by CI).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../../src/server.js';
import type { McpAuthConfig } from '../../src/types.js';
import { TEST_CHALLENGE, TEST_CLIENT_ID, TEST_REDIRECT_URI, asGrantex, clientRecord, mockGrantex, seededStorage } from '../helpers.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const LONG_CLIENT = 'client-with-a-very-long-identifier-0123456789abcdef0123456789abcdef-that-must-wrap';
const SCREENSHOTS = new URL('../../test-results/', import.meta.url);

let app: FastifyInstance;
let base: string;
let browser: Browser;
const grantex = mockGrantex();

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

beforeAll(async () => {
  mkdirSync(SCREENSHOTS, { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const storage = await seededStorage(
    clientRecord({ clientName: 'Acme Underwriting Assistant' }),
    clientRecord({ clientId: LONG_CLIENT, clientName: 'Acme Underwriting Assistant for the Northern Region Operations Team', redirectUris: ['http://127.0.0.1:33418/oauth/callback/with/a/long/path/segment'], publicClient: true }),
  );
  app = await createMcpAuthServer({
    grantex: asGrantex(grantex),
    agentId: 'agent-1',
    issuer: base,
    resource: RESOURCE,
    resourceName: 'Acme KYB tools',
    manifests: [{
      connector: 'acme_kyb',
      tools: {
        resolve_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'], caps: { per_hour: 200 } },
        verify_business: { permission: 'read', caps: { per_hour: 50, per_case: 3 } },
        screen_person: { permission: 'read', caps: { per_case: 25 } },
        monitor_enroll: { permission: 'write' },
        case_decision: { permission: 'write', requires_decision: true },
      },
    }],
    grant: { purpose: 'aml.cdd.onboarding', purposeDescription: 'Business onboarding checks for new applicants', dataRegion: 'eu', duration: '8h' },
    consentUi: { appName: 'Acme Compliance', privacyUrl: 'https://acme.example.com/privacy', termsUrl: 'https://acme.example.com/terms' },
    storage,
  } as McpAuthConfig);
  await app.listen({ port, host: '127.0.0.1' });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
});

function authorizeUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: TEST_CLIENT_ID,
    redirect_uri: TEST_REDIRECT_URI,
    code_challenge: TEST_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'tool:acme_kyb:write',
    state: 'e2e-state',
    ...query,
  });
  return `${base}/authorize?${params}`;
}

async function open(context: BrowserContext, url: string): Promise<{ page: Page; cspViolations: string[] }> {
  const page = await context.newPage();
  const cspViolations: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
  });
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  return { page, cspViolations };
}

async function expectNoAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`);
  expect(summary).toEqual([]);
  expect(results.passes.length).toBeGreaterThan(10);
}

async function expectFitsViewport(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const width = window.innerWidth;
    const overflowing = [...document.querySelectorAll('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > width + 1 || rect.left < -1);
      })
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    return { width, scrollWidth: document.documentElement.scrollWidth, overflowing };
  });
  expect(layout.overflowing).toEqual([]);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
}

describe('consent page in a real browser', () => {
  it('renders correctly at 375 px: everything visible, nothing overflows, touch targets are large enough', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      const { page, cspViolations } = await open(context, authorizeUrl());
      for (const text of ['Allow access?', 'Acme Underwriting Assistant', 'app.example.com', 'aml.cdd.onboarding', '8 hours', 'Acme KYB tools', 'verify_business', 'declared limit per case: 3 calls', 'Needs a person to approve each action']) {
        await expect.poll(() => page.getByText(text, { exact: false }).first().isVisible()).toBe(true);
      }
      await expectFitsViewport(page);
      for (const name of ['Allow', 'Deny']) {
        const box = await page.getByRole('button', { name, exact: true }).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      }
      // The hashed stylesheet applied (a CSP block would leave default button styling).
      const accent = await page.getByRole('button', { name: 'Allow', exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(accent).toBe('rgb(29, 78, 216)');
      expect(cspViolations).toEqual([]);
      await page.screenshot({ path: fileURLToPath(new URL('consent-mobile-375.png', SCREENSHOTS)), fullPage: true });
    } finally {
      await context.close();
    }
  });

  it('long names, ids and localhost redirect URIs wrap instead of overflowing at 375 px', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    try {
      const { page } = await open(context, authorizeUrl({
        client_id: LONG_CLIENT,
        redirect_uri: 'http://127.0.0.1:33418/oauth/callback/with/a/long/path/segment',
      }));
      await expect.poll(() => page.getByText('runs on your own device (localhost)', { exact: false }).isVisible()).toBe(true);
      await expectFitsViewport(page);
      await expectNoAxeViolations(page);
      await page.screenshot({ path: fileURLToPath(new URL('consent-mobile-375-long.png', SCREENSHOTS)), fullPage: true });
    } finally {
      await context.close();
    }
  });

  it('passes axe-core (WCAG 2.x A/AA and best practices) at mobile and desktop widths', async () => {
    for (const viewport of [{ width: 375, height: 812 }, { width: 1280, height: 900 }]) {
      const context = await browser.newContext({ viewport });
      try {
        const { page } = await open(context, authorizeUrl());
        await expectNoAxeViolations(page);
        if (viewport.width === 1280) {
          await page.screenshot({ path: fileURLToPath(new URL('consent-desktop-1280.png', SCREENSHOTS)), fullPage: true });
        }
      } finally {
        await context.close();
      }
    }
  });

  it('keyboard users can reach both buttons in a sensible order', async () => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    try {
      const { page } = await open(context, authorizeUrl());
      const focused: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press('Tab');
        focused.push(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? ''));
      }
      expect(focused.indexOf('Allow')).toBeGreaterThanOrEqual(0);
      expect(focused.indexOf('Deny')).toBeGreaterThan(focused.indexOf('Allow'));
    } finally {
      await context.close();
    }
  });

  it('Deny, clicked in the browser, returns to the client with access_denied', async () => {
    const context = await browser.newContext();
    try {
      const { page, cspViolations } = await open(context, authorizeUrl());
      // The browser follows the 303 to the client's redirect URI. (That host
      // does not resolve in tests; the request being made at all shows the
      // CSP form-action allowed it.)
      const [request] = await Promise.all([
        page.waitForRequest((r) => r.url().startsWith(TEST_REDIRECT_URI)),
        page.getByRole('button', { name: 'Deny', exact: true }).click(),
      ]);
      const url = new URL(request.url());
      expect(url.searchParams.get('error')).toBe('access_denied');
      expect(url.searchParams.get('state')).toBe('e2e-state');
      expect(url.searchParams.get('iss')).toBe(base);
      expect(cspViolations).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it('Allow, clicked in the browser, continues to Grantex (cookie, Origin and CSP form-action all accepted)', async () => {
    const context = await browser.newContext();
    try {
      const calls = grantex.authorize.mock.calls.length;
      const { page, cspViolations } = await open(context, authorizeUrl());
      const consentPost = page.waitForResponse((r) => r.url() === `${base}/consent`);
      const [request] = await Promise.all([
        page.waitForRequest((r) => r.url() === 'https://grantex.example.com/consent'),
        page.getByRole('button', { name: 'Allow', exact: true }).click(),
      ]);
      expect(request.url()).toBe('https://grantex.example.com/consent');
      expect((await consentPost).status()).toBe(303);
      expect(grantex.authorize.mock.calls.length).toBe(calls + 1);
      expect(cspViolations).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
