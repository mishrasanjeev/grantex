import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage/memory.js';
import { contrastRatio, DEFAULT_THEME } from '../src/consent/theme.js';
import { escapeHtml, html } from '../src/consent/html.js';
import type { McpAuthConfig } from '../src/types.js';
import type { LoadedManifest } from '../src/resource/tool-policy.js';
import {
  TEST_CHALLENGE,
  TEST_CLIENT_ID,
  TEST_REDIRECT_URI,
  TEST_RESOURCE,
  asGrantex,
  callbackCookieFrom,
  clientRecord,
  consentFormFrom,
  mockGrantex,
  seededStorage,
  submitConsent,
} from './helpers.js';
import type { MockGrantex } from './helpers.js';

const ISSUER = 'https://auth.example.com';

const ACME_KYB: LoadedManifest = {
  connector: 'acme_kyb',
  tools: {
    resolve_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'], caps: { per_hour: 200 } },
    verify_business: { permission: 'read', caps: { per_hour: 50, per_case: 3 } },
    monitor_enroll: { permission: 'write' },
    case_decision: { permission: 'write', requires_decision: true },
  },
};

type Overrides = { [K in keyof McpAuthConfig]?: McpAuthConfig[K] | undefined };

async function build(overrides: Overrides = {}, grantex: MockGrantex = mockGrantex()) {
  const storage = overrides.storage ?? await seededStorage(clientRecord({ clientName: 'Acme Underwriting Assistant' }));
  const app = await createMcpAuthServer({
    grantex: asGrantex(grantex),
    agentId: 'agent-1',
    issuer: ISSUER,
    resource: TEST_RESOURCE,
    resourceName: 'Acme KYB tools',
    manifests: [ACME_KYB],
    grant: { purpose: 'aml.cdd.onboarding', purposeDescription: 'Business onboarding checks', dataRegion: 'eu', duration: '8h' },
    consentUi: { appName: 'Acme Compliance', privacyUrl: 'https://acme.example.com/privacy' },
    storage,
    ...overrides,
  } as McpAuthConfig);
  return { app, grantex, storage };
}

function authorize(app: FastifyInstance, query: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: '/authorize',
    query: {
      response_type: 'code',
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      code_challenge: TEST_CHALLENGE,
      code_challenge_method: 'S256',
      scope: 'tool:acme_kyb:read',
      state: 'client-state',
      ...query,
    },
  });
}

function post(app: FastifyInstance, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: new URLSearchParams(fields).toString(),
  });
}

describe('the consent page', () => {
  it('is shown before anything is sent to Grantex (confused deputy protection)', async () => {
    const { app, grantex } = await build();
    const page = await authorize(app);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('shows the client, redirect host, purpose, tools with caps, region, duration and service', async () => {
    const { app } = await build();
    const { body } = await authorize(app);
    for (const expected of [
      'Acme Underwriting Assistant',
      'app.example.com', // redirect host, shown prominently
      'aml.cdd.onboarding',
      'Business onboarding checks',
      '<dd>eu</dd>',
      '8 hours',
      'Acme KYB tools',
      TEST_RESOURCE,
      'resolve_business',
      'verify_business',
      'per hour: at most 50 calls',
      'per case: at most 3 calls',
      'tool:acme_kyb:read',
    ]) {
      expect(body).toContain(expected);
    }
    // Tools the requested scope does not cover are not listed as granted.
    expect(body).not.toContain('monitor_enroll');
    expect(body).toMatch(/<p class="redirect wrap">app\.example\.com<\/p>/);
  });

  it('flags tools that need a decision grant', async () => {
    const { app } = await build();
    const { body } = await authorize(app, { scope: 'tool:acme_kyb:write' });
    expect(body).toContain('case_decision');
    expect(body).toContain('Needs a person to approve each action');
  });

  it('warns when every redirect URI is on localhost', async () => {
    const storage = await seededStorage(clientRecord({ redirectUris: ['http://127.0.0.1:33418/callback'] }));
    const { app } = await build({ storage });
    const { body } = await authorize(app, { redirect_uri: 'http://127.0.0.1:33418/callback' });
    expect(body).toContain('runs on your own device (localhost)');
    expect(body).toContain('127.0.0.1:33418');
  });

  it('escapes every untrusted value and contains no script', async () => {
    const { app, storage } = await build();
    const registered = await app.inject({
      method: 'POST',
      url: '/register',
      payload: {
        redirect_uris: ['https://app.example.com/cb?next=<img src=x onerror=alert(1)>'],
        client_name: '<script>alert("x")</script>"><img src=x onerror=alert(2)>',
      },
    });
    const { client_id: clientId } = registered.json() as { client_id: string };
    expect(await storage.getClient(clientId)).toBeDefined();
    const page = await authorize(app, {
      client_id: clientId,
      redirect_uri: 'https://app.example.com/cb?next=<img src=x onerror=alert(1)>',
      state: '"><script>alert(3)</script>',
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).not.toMatch(/<img src=x/i);
    expect(page.body).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('is served with a strict CSP whose style hash matches the inline stylesheet', async () => {
    const { app } = await build({ consentUi: { appName: 'Acme', appLogo: 'https://cdn.acme.example.com/logo.png' } });
    const page = await authorize(app);
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self' https:");
    expect(csp).toContain('img-src https://cdn.acme.example.com');
    const css = /<style>([\s\S]*?)<\/style>/.exec(page.body)![1]!;
    const hash = createHash('sha256').update(css, 'utf8').digest('base64');
    expect(csp).toContain(`style-src 'sha256-${hash}'`);
    expect(page.body).not.toMatch(/style="/);
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['referrer-policy']).toBe('same-origin');
  });

  it('sets a host-only, Secure, HttpOnly, SameSite=Strict browser-binding cookie', async () => {
    const { app } = await build();
    const page = await authorize(app);
    const cookie = String(page.headers['set-cookie']);
    expect(cookie).toMatch(/^__Host-mcp_auth_consent_[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=600; Secure$/);
  });

  it('uses a non-prefixed cookie without Secure for a localhost http issuer', async () => {
    const { app } = await build({ issuer: 'http://127.0.0.1:4010' });
    const page = await authorize(app);
    const cookie = String(page.headers['set-cookie']);
    expect(cookie.startsWith('mcp_auth_consent_')).toBe(true);
    expect(cookie).not.toContain('Secure');
  });
});

describe('submitting the consent form', () => {
  it('approve starts the upstream authorization with the grant duration and extension parameters', async () => {
    const authorizeParams = (request: { clientId: string; scopes: string[]; resource: string }) => ({
      authorizationDetails: [{ type: 'urn:grantex:tools:v1', purpose: 'aml.cdd.onboarding', resource: request.resource }],
      agentId: 'attempted-override',
      audience: 'https://attacker.example.org',
    });
    const grantex = mockGrantex();
    const { app } = await build({
      grant: { purpose: 'aml.cdd.onboarding', duration: '8h', authorizeParams },
    }, grantex);
    const page = await authorize(app);
    const result = await submitConsent(app, page, 'approve', ISSUER);
    expect(result.statusCode).toBe(303);
    expect(result.headers['location']).toBe('https://grantex.example.com/consent');
    expect(grantex.authorize).toHaveBeenCalledTimes(1);
    expect(grantex.authorize.mock.calls[0]![0]).toMatchObject({
      agentId: 'agent-1',
      audience: TEST_RESOURCE,
      scopes: ['tool:acme_kyb:read'],
      expiresIn: '8h',
      authorizationDetails: [{ type: 'urn:grantex:tools:v1', purpose: 'aml.cdd.onboarding', resource: TEST_RESOURCE }],
    });
    // The consent cookie is cleared.
    expect(String(result.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('approve with sandbox auto-approval issues the code with 303', async () => {
    const { app } = await build({ sandboxAutoApprove: true }, mockGrantex({ sandboxCode: 'UPSTREAM' }));
    const result = await submitConsent(app, await authorize(app), 'approve', ISSUER);
    expect(result.statusCode).toBe(303);
    const location = new URL(String(result.headers['location']));
    expect(location.origin + location.pathname).toBe(TEST_REDIRECT_URI);
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('client-state');
  });

  it('deny redirects the client with access_denied, state and iss, and never calls Grantex', async () => {
    const { app, grantex } = await build();
    const result = await submitConsent(app, await authorize(app), 'deny', ISSUER);
    expect(result.statusCode).toBe(303);
    const location = new URL(String(result.headers['location']));
    expect(Object.fromEntries(location.searchParams)).toEqual({ error: 'access_denied', state: 'client-state', iss: ISSUER });
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('a page can be submitted once', async () => {
    const { app, grantex } = await build();
    const page = await authorize(app);
    expect((await submitConsent(app, page, 'approve', ISSUER)).statusCode).toBe(303);
    const replay = await submitConsent(app, page, 'approve', ISSUER);
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain('This request has expired');
    expect(grantex.authorize).toHaveBeenCalledTimes(1);
  });

  it('CSRF: a wrong token is refused and spends the page', async () => {
    const { app, grantex } = await build();
    const page = await authorize(app);
    const { consentId, cookie } = consentFormFrom(page);
    const forged = await post(app, { consent_id: consentId, csrf_token: 'guessed', decision: 'approve' }, { cookie, 'sec-fetch-site': 'same-origin' });
    expect(forged.statusCode).toBe(403);
    expect((await submitConsent(app, page, 'approve', ISSUER)).statusCode).toBe(400);
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('CSRF: the browser-binding cookie is required and must match', async () => {
    const { app, grantex } = await build();
    for (const cookie of [undefined, 'wrong']) {
      const page = await authorize(app);
      const { consentId, csrfToken, cookie: real } = consentFormFrom(page);
      const headers: Record<string, string> = { 'sec-fetch-site': 'same-origin' };
      if (cookie === 'wrong') headers['cookie'] = `${real.split('=')[0]}=${'A'.repeat(43)}`;
      const result = await post(app, { consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }, headers);
      expect(result.statusCode).toBe(403);
    }
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('CSRF: a cross-site submission is refused without spending the page', async () => {
    const { app } = await build();
    const page = await authorize(app);
    const { consentId, csrfToken, cookie } = consentFormFrom(page);
    const fields = { consent_id: consentId, csrf_token: csrfToken, decision: 'approve' };
    expect((await post(app, fields, { cookie, 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await post(app, fields, { cookie, origin: 'https://attacker.example.org' })).statusCode).toBe(403);
    expect((await submitConsent(app, page, 'approve', ISSUER)).statusCode).toBe(303);
  });

  it('refuses duplicated fields, a missing decision and an unknown consent id', async () => {
    const { app } = await build();
    const page = await authorize(app);
    const { consentId, csrfToken, cookie } = consentFormFrom(page);
    const duplicated = await app.inject({
      method: 'POST',
      url: '/consent',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `consent_id=${consentId}&csrf_token=${csrfToken}&decision=deny&decision=approve`,
    });
    expect(duplicated.statusCode).toBe(400);
    expect((await post(app, { consent_id: consentId, csrf_token: csrfToken }, { cookie })).statusCode).toBe(400);
    expect((await post(app, { consent_id: 'unknown', csrf_token: csrfToken, decision: 'approve' }, { cookie })).statusCode).toBe(400);
  });

  it('two pages open at once can both be submitted', async () => {
    const { app } = await build();
    const first = await authorize(app, { state: 'one' });
    const second = await authorize(app, { state: 'two' });
    expect(consentFormFrom(first).cookie.split('=')[0]).not.toBe(consentFormFrom(second).cookie.split('=')[0]);
    expect((await submitConsent(app, second, 'deny', ISSUER)).statusCode).toBe(303);
    expect((await submitConsent(app, first, 'deny', ISSUER)).statusCode).toBe(303);
  });

  it('re-checks the client before going upstream', async () => {
    const { app, storage, grantex } = await build();
    const page = await authorize(app);
    await storage.deleteClient(TEST_CLIENT_ID);
    const result = await submitConsent(app, page, 'approve', ISSUER);
    expect(result.statusCode).toBe(400);
    expect(grantex.authorize).not.toHaveBeenCalled();
  });
});

describe('customisation', () => {
  it('applies theme colours, text and extra CSS, keeping the CSP hash in step', async () => {
    const { app } = await build({
      consentPage: {
        theme: { accentColor: '#0b6e4f', radiusPx: 4, fontFamily: '"Inter", system-ui, sans-serif' },
        text: { title: 'Grant access to your case tools?', approve: 'Grant access' },
        extraCss: '.card{box-shadow:none}',
        lang: 'en-GB',
      },
    });
    const page = await authorize(app);
    expect(page.body).toContain('--accent:#0b6e4f');
    expect(page.body).toContain('Grant access to your case tools?');
    expect(page.body).toContain('>Grant access</button>');
    expect(page.body).toContain('.card{box-shadow:none}');
    expect(page.body).toContain('<html lang="en-GB">');
    const css = /<style>([\s\S]*?)<\/style>/.exec(page.body)![1]!;
    expect(String(page.headers['content-security-policy'])).toContain(createHash('sha256').update(css).digest('base64'));
  });

  it('renderDetails replaces the details section; values stay escaped and the form and redirect host remain', async () => {
    const { app } = await build({
      consentPage: {
        renderDetails: (model, h) => h.html`<section><h2>Case access</h2><p>${model.client.name}</p><p>${'<b>raw</b>'}</p></section>`,
      },
    });
    const page = await authorize(app);
    expect(page.body).toContain('<h2>Case access</h2>');
    expect(page.body).toContain('&lt;b&gt;raw&lt;/b&gt;');
    expect(page.body).not.toContain('What you are granting');
    expect(page.body).toContain('name="csrf_token"');
    expect(page.body).toMatch(/<p class="redirect wrap">app\.example\.com<\/p>/);
  });

  it('a renderDetails that returns a plain string is refused rather than rendered unescaped', async () => {
    const { app } = await build({
      consentPage: { renderDetails: (() => '<p>unescaped</p>') as never },
    });
    const page = await authorize(app);
    expect(page.statusCode).toBe(500);
    expect(page.body).not.toContain('<p>unescaped</p>');
  });

  it('refuses unreadable or unsafe themes and options at start-up', async () => {
    const storage = new InMemoryStorage();
    for (const [consentPage, message] of [
      [{ theme: { textColor: '#bbbbbb' } }, /contrast/],
      [{ theme: { accentColor: 'red;}body{display:none' } }, /hex colour/],
      [{ theme: { fontFamily: 'x;}</style><script>' } }, /fontFamily/],
      [{ theme: { radiusPx: 99 } }, /radiusPx/],
      [{ extraCss: '</style><script>alert(1)</script>' }, /extraCss/],
      [{ lang: 'en"><script>' }, /lang/],
    ] as const) {
      await expect(build({ storage, consentPage: consentPage as McpAuthConfig['consentPage'] })).rejects.toThrow(message);
    }
    await expect(build({ storage, consentUi: { appLogo: 'http://acme.example.com/logo.png' } })).rejects.toThrow(/https URL/);
    await expect(build({ storage, grant: { purpose: 'Marketing Enrichment!' } })).rejects.toThrow(/purpose code/);
    await expect(build({ storage, grant: { duration: 'forever' } })).rejects.toThrow(/duration/);
    await expect(build({ storage, grant: { dataRegion: 'eu; drop' } })).rejects.toThrow(/dataRegion/);
  });

  it('the default theme meets WCAG AA contrast', () => {
    expect(contrastRatio(DEFAULT_THEME.textColor, DEFAULT_THEME.surfaceColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DEFAULT_THEME.mutedTextColor, DEFAULT_THEME.surfaceColor)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(DEFAULT_THEME.accentTextColor, DEFAULT_THEME.accentColor)).toBeGreaterThanOrEqual(4.5);
  });

  it('the html helper escapes interpolations and nests safely', () => {
    expect(html`<p>${'<a href="x">&</a>'}</p>`.value).toBe('<p>&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;</p>');
    expect(html`<ul>${['<1>', html`<li>${'2'}</li>`]}</ul>`.value).toBe('<ul>&lt;1&gt;<li>2</li></ul>');
    expect(escapeHtml("'`")).toBe('&#39;&#96;');
  });
});

describe('the upstream round trip is bound to the browser that approved', () => {
  async function approvedFlow() {
    const grantex = mockGrantex();
    const { app, storage } = await build({}, grantex);
    const approved = await submitConsent(app, await authorize(app), 'approve', ISSUER);
    expect(approved.statusCode).toBe(303);
    const state = (grantex.authorize.mock.calls[0]![0] as { state: string }).state;
    return { app, storage, approved, state, cookie: callbackCookieFrom(approved) };
  }

  const callback = (app: FastifyInstance, state: string, cookie?: string) => app.inject({
    method: 'GET',
    url: '/callback',
    ...(cookie !== undefined ? { headers: { cookie } } : {}),
    query: { code: 'UPSTREAM_LIVE_CODE', state },
  });

  it('approving sets a __Host-, Secure, HttpOnly, SameSite=Lax callback cookie', async () => {
    const { approved } = await approvedFlow();
    const cookies = ([] as string[]).concat(approved.headers['set-cookie'] as string | string[]);
    const binding = cookies.find((c) => c.startsWith('__Host-mcp_auth_callback_'));
    expect(binding).toMatch(/^__Host-mcp_auth_callback_[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  });

  it('confused deputy: a victim who opens the attacker\'s upstream consent link gets no code', async () => {
    // The attacker approved consent for their own client and now sends the
    // Grantex consent URL to a victim, whose browser returns to /callback
    // without the attacker's binding cookie.
    const { app, state, cookie } = await approvedFlow();
    const victim = await callback(app, state);
    expect(victim.statusCode).toBe(403);
    expect(victim.headers['location']).toBeUndefined();
    expect(victim.body).not.toMatch(/code=/);
    // The authorization is spent: not even the attacker's own browser can finish it now.
    expect((await callback(app, state, cookie)).statusCode).toBe(400);
  });

  it('a different browser\'s cookie is refused', async () => {
    const { app, state, cookie } = await approvedFlow();
    const [name] = cookie.split('=');
    expect((await callback(app, state, `${name}=${'B'.repeat(43)}`)).statusCode).toBe(403);
  });

  it('the approving browser receives the code and the cookie is cleared', async () => {
    const { app, state, cookie } = await approvedFlow();
    const result = await callback(app, state, cookie);
    expect(result.statusCode).toBe(302);
    expect(new URL(String(result.headers['location'])).searchParams.get('code')).toBeTruthy();
    expect(String(result.headers['set-cookie'])).toMatch(/mcp_auth_callback_[A-Za-z0-9_-]{16}=; .*Max-Age=0/);
  });

  it('a pending authorization without a binding (written before binding existed) is refused', async () => {
    const { app, storage } = await build();
    await storage.putPendingAuthorization('legacy-state-0123456789', {
      clientId: TEST_CLIENT_ID,
      redirectUri: TEST_REDIRECT_URI,
      codeChallenge: TEST_CHALLENGE,
      codeChallengeMethod: 'S256',
      scopes: ['tool:acme_kyb:read'],
      resource: TEST_RESOURCE,
      grantexAuthRequestId: 'areq_legacy',
      expiresAt: Date.now() + 60_000,
    });
    expect((await callback(app, 'legacy-state-0123456789')).statusCode).toBe(403);
  });
});
