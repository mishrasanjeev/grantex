import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../../../../web/playground.html', import.meta.url)), 'utf8');

function token(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

type ApiFixture = {
  calls: Array<{ path: string; method: string; authorization: string | undefined; body: unknown }>;
  failNext: Map<string, number>;
  malformedNext: Map<string, Record<string, unknown>>;
  abortNext: Set<string>;
  delayNext: Set<string>;
  releaseDelay: () => void;
  setTokenClaims: (claims: Record<string, unknown>) => void;
};

async function mockApi(page: Page): Promise<ApiFixture> {
  const calls: ApiFixture['calls'] = [];
  const failNext = new Map<string, number>();
  const malformedNext = new Map<string, Record<string, unknown>>();
  const abortNext = new Set<string>();
  const delayNext = new Set<string>();
  let resolveDelay = () => {};
  let delayed = new Promise<void>((resolve) => { resolveDelay = resolve; });
  let revoked = false;
  let firstToken = token({ jti: 'jti_1', sub: 'test-user', scp: ['calendar:read'] });
  const secondToken = token({ jti: 'jti_2', sub: 'test-user', scp: ['calendar:read'] });

  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const body = request.postData() ? request.postDataJSON() as unknown : null;
    calls.push({ path, method: request.method(), authorization: request.headers()['authorization'], body });
    if (delayNext.delete(path)) {
      await delayed;
      delayed = new Promise<void>((resolve) => { resolveDelay = resolve; });
    }
    if (abortNext.delete(path)) {
      await route.abort('failed');
      return;
    }
    const remaining = failNext.get(path) ?? 0;
    if (remaining > 0) {
      failNext.set(path, remaining - 1);
      await route.fulfill({ status: 503, headers, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary failure' }) });
      return;
    }
    const malformed = malformedNext.get(path);
    if (malformed) {
      malformedNext.delete(path);
      await route.fulfill({ status: ['/v1/tokens/verify', '/v1/me'].includes(path) ? 200 : 201, headers, contentType: 'application/json', body: JSON.stringify(malformed) });
      return;
    }
    const responses: Record<string, { status: number; data: unknown }> = {
      '/v1/signup': { status: 201, data: { apiKey: 'gx_sandbox_fixture' } },
      '/v1/me': { status: 200, data: { mode: 'sandbox' } },
      '/v1/agents': { status: 201, data: { agentId: 'ag_fixture', did: 'did:grantex:ag_fixture' } },
      '/v1/authorize': { status: 201, data: { code: 'code_fixture' } },
      '/v1/token': { status: 201, data: { grantToken: firstToken, refreshToken: 'rt_one', grantId: 'grnt_fixture' } },
      '/v1/token/refresh': { status: 201, data: { grantToken: secondToken, refreshToken: 'rt_two' } },
      '/v1/tokens/verify': { status: 200, data: { valid: !revoked } },
      '/v1/grants/grnt_fixture': { status: 204, data: null },
    };
    const response = responses[path] ?? { status: 404, data: { message: 'Not found' } };
    if (path === '/v1/grants/grnt_fixture' && response.status === 204) revoked = true;
    await route.fulfill({
      status: response.status, headers,
      ...(response.status === 204 ? {} : { contentType: 'application/json', body: JSON.stringify(response.data) }),
    });
  });

  return { calls, failNext, malformedNext, abortNext, delayNext,
    releaseDelay: () => resolveDelay(), setTokenClaims: (claims) => { firstToken = token(claims); } };
}

async function run(page: Page, step: number, expectedBadge = 'Done'): Promise<void> {
  await page.locator(`#run${step}`).click();
  await page.locator(`#badge${step}`).getByText(expectedBadge, { exact: true }).waitFor();
}

describe('public playground in Chromium', () => {
  let server: Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No browser test port');
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('completes all seven steps and clears credentials and responses on Reset', async () => {
    const page = await browser.newPage();
    try {
      const api = await mockApi(page);
      await page.goto(`${baseUrl}/playground`);
      await page.locator('#startBtn').click();
      await page.locator('#run1').waitFor({ state: 'visible' });
      for (let step = 1; step <= 7; step++) await run(page, step, step === 7 ? 'Revoked' : 'Done');
      expect(api.calls.map((call) => call.path)).toEqual([
        '/v1/signup', '/v1/me', '/v1/agents', '/v1/authorize', '/v1/token',
        '/v1/tokens/verify', '/v1/token/refresh', '/v1/grants/grnt_fixture', '/v1/tokens/verify',
      ]);
      expect(api.calls[0]?.authorization).toBeUndefined();
      expect(api.calls.slice(1).every((call) => call.authorization === 'Bearer gx_sandbox_fixture')).toBe(true);
      expect(await page.locator('#req4').innerText()).not.toContain('Authorization: Bearer');
      expect(await page.locator('#res7').innerText()).toContain('"valid": false');
      const firstHeader = page.locator('#step1 .step-header');
      await firstHeader.focus();
      await page.keyboard.press('Enter');
      expect(await firstHeader.getAttribute('aria-expanded')).toBe('true');
      expect(await page.locator('#stepBody1').isVisible()).toBe(true);
      await page.keyboard.press('Space');
      expect(await firstHeader.getAttribute('aria-expanded')).toBe('false');
      expect(await page.locator('#stepBody1').isHidden()).toBe(true);
      await page.locator('#resetBtn').click();
      expect(await page.locator('#stepsContainer').isHidden()).toBe(true);
      expect(await page.locator('#apiKey').inputValue()).toBe('');
      expect(await page.locator('#res3').innerText()).toBe('');
      expect(await page.locator('#jwt3-claims').innerText()).toBe('');
      expect(await page.locator('#run1').isEnabled()).toBe(true);
      expect(await page.locator('#run2').isDisabled()).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('uses a custom sandbox key and URL, and each failed step can be retried', async () => {
    const page = await browser.newPage();
    try {
      const api = await mockApi(page);
      await page.goto(`${baseUrl}/playground`);
      await page.locator('#advancedToggle').click();
      await page.locator('#apiKey').fill('gx_sandbox_custom');
      await page.locator('#baseUrl').fill(baseUrl);
      await page.locator('#advancedToggle').click();
      await page.locator('#startBtn').click();
      await page.locator('#run1').waitFor({ state: 'visible' });
      for (const [step, path] of [
        [1, '/v1/agents'], [2, '/v1/authorize'], [3, '/v1/token'],
        [4, '/v1/tokens/verify'], [5, '/v1/token/refresh'],
        [6, '/v1/grants/grnt_fixture'], [7, '/v1/tokens/verify'],
      ] as const) {
        api.failNext.set(path, 1);
        await run(page, step, 'Error');
        expect(await page.locator(`#run${step}`).isEnabled()).toBe(true);
        await run(page, step, step === 7 ? 'Revoked' : 'Done');
      }
      expect(api.calls.some((call) => call.path === '/v1/signup')).toBe(false);
      expect(api.calls.every((call) => call.authorization === 'Bearer gx_sandbox_custom')).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('rejects unsafe URLs and malformed API responses without advancing', async () => {
    const page = await browser.newPage();
    try {
      const api = await mockApi(page);
      await page.goto(`${baseUrl}/playground`);
      await page.locator('#advancedToggle').click();
      await page.locator('#baseUrl').fill('http://example.com');
      await page.locator('#startBtn').click();
      expect(await page.locator('#setupError').innerText()).toContain('HTTPS');
      expect(api.calls).toHaveLength(0);
      await page.locator('#baseUrl').fill(baseUrl);
      await page.locator('#apiKey').fill('gx_live_fixture');
      api.malformedNext.set('/v1/me', { mode: 'live' });
      await page.locator('#startBtn').click();
      await page.locator('#setupError').getByText('sandbox-mode keys only').waitFor();
      expect(api.calls.some((call) => call.path === '/v1/agents')).toBe(false);
      await page.locator('#apiKey').fill('');
      api.failNext.set('/v1/signup', 1);
      await page.locator('#startBtn').click();
      await page.locator('#setupError').getByText('Temporary failure').waitFor();
      expect(await page.locator('#startBtn').isEnabled()).toBe(true);
      await page.locator('#startBtn').click();
      await page.locator('#run1').waitFor({ state: 'visible' });
      api.malformedNext.set('/v1/agents', {});
      await run(page, 1, 'Error');
      expect(await page.locator('#run2').isDisabled()).toBe(true);
      await run(page, 1);
      api.malformedNext.set('/v1/authorize', { authorizationUrl: 'https://example.com/consent' });
      await run(page, 2, 'Error');
      expect(await page.locator('#res2').innerText()).toContain('requires a sandbox key');
      await run(page, 2);
      api.malformedNext.set('/v1/token', { grantToken: 'bad' });
      await run(page, 3, 'Error');
      await run(page, 3);
      api.malformedNext.set('/v1/tokens/verify', { valid: false });
      await run(page, 4, 'Error');
      await run(page, 4);
      api.malformedNext.set('/v1/token/refresh', { grantToken: 'bad' });
      await run(page, 5, 'Error');
      await run(page, 5);
      api.malformedNext.set('/v1/tokens/verify', { valid: true });
      await run(page, 6);
      await run(page, 7, 'Error');
      await run(page, 7, 'Revoked');
    } finally {
      await page.close();
    }
  });

  it('renders hostile JWT claims as text and ignores a response after Reset', async () => {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    try {
      const api = await mockApi(page);
      api.setTokenClaims({ sub: '<img src=x onerror="window.playgroundXss=1">', exp: 1730000000 });
      await page.goto(`${baseUrl}/playground`);
      const logo = await page.locator('.nav-logo').boundingBox();
      const docsLink = await page.locator('.nav-links a', { hasText: 'Docs' }).boundingBox();
      expect(logo && docsLink && logo.x + logo.width < docsLink.x).toBe(true);
      await page.locator('#advancedToggle').click();
      await page.locator('#apiKey').fill('gx_sandbox_custom');
      await page.locator('#baseUrl').fill(baseUrl);
      await page.locator('#startBtn').click();
      await page.locator('#run1').waitFor({ state: 'visible' });
      await run(page, 1);
      await run(page, 2);
      await run(page, 3);
      await page.locator('#step3 .step-header').click();
      await page.locator('#jwt3 summary').click();
      expect(await page.locator('#jwt3-claims').innerText()).toContain('<img src=x');
      expect(await page.locator('#jwt3-claims img').count()).toBe(0);
      expect(await page.evaluate('window.playgroundXss')).toBeUndefined();
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

      await page.locator('#step4 .step-header').click();
      api.delayNext.add('/v1/tokens/verify');
      await page.locator('#run4').click();
      await page.locator('#badge4').getByText('Running...', { exact: true }).waitFor();
      await page.locator('#resetBtn').click();
      api.releaseDelay();
      expect(await page.locator('#stepsContainer').isHidden()).toBe(true);
      expect(await page.locator('#badge4').innerText()).toBe('Pending');
      expect(await page.locator('#res4').innerText()).toBe('');
    } finally {
      await page.close();
    }
  });
});
