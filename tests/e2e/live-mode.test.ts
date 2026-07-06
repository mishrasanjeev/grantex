/**
 * Live-mode E2E: exercises the real consent flow end-to-end through
 * https://grantex.dev (Firebase Hosting → Cloud Run rewrites).
 *
 * Existing e2e suites sign up as sandbox, which returns `code` inline and
 * never loads the consent page. That masked PR #299's bug where the live
 * consentUrl 404'd on grantex.dev. This suite fails loudly when any of the
 * Firebase → Cloud Run rewrites regress.
 *
 * Run: npx vitest run tests/e2e/live-mode.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env['E2E_BASE_URL'] ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';
const PUBLIC_BASE_URL = process.env['E2E_PUBLIC_BASE_URL'] ?? 'https://grantex.dev';

let grantex: Grantex;
let apiKey: string;
let mainAgentId: string;

beforeAll(async () => {
  const account = await Grantex.signup(
    { name: `e2e-live-${Date.now()}`, mode: 'live' },
    { baseUrl: BASE_URL },
  );
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });

  // Developer-mode sanity: the API key prefix encodes live vs sandbox.
  expect(apiKey.startsWith('gx_live_')).toBe(true);

  const agent = await grantex.agents.register({
    name: `e2e-live-agent-${Date.now()}`,
    scopes: ['calendar:read', 'email:send'],
  });
  mainAgentId = agent.agentId;
});

describe('live-mode: Firebase -> Cloud Run rewrites', () => {
  it('.well-known/jwks.json is reachable via grantex.dev', async () => {
    const res = await fetch(`${PUBLIC_BASE_URL}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys?: unknown[] };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys!.length).toBeGreaterThan(0);
  });

  it('.well-known/did.json is reachable via grantex.dev', async () => {
    const res = await fetch(`${PUBLIC_BASE_URL}/.well-known/did.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; '@context'?: unknown };
    expect(body.id).toBe('did:web:grantex.dev');
    expect(body['@context']).toBeDefined();
  });

  it('POST /v1/webauthn/assert/options reaches Cloud Run via grantex.dev', async () => {
    const res = await fetch(`${PUBLIC_BASE_URL}/v1/webauthn/assert/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authRequestId: 'areq_missing_rewrite_smoke' }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('NOT_FOUND');
  });
});

describe('live-mode: full consent flow', () => {
  let authRequestId: string;
  let consentUrl: string;

  it('POST /v1/authorize returns pending + grantex.dev consentUrl', async () => {
    const auth = await grantex.authorize({
      agentId: mainAgentId,
      userId: `principal-${Date.now()}`,
      scopes: ['calendar:read', 'email:send'],
    });

    // Live mode must NOT return a code inline (that's sandbox/auto-approve).
    expect((auth as Record<string, unknown>)['code']).toBeUndefined();
    expect((auth as Record<string, unknown>)['sandbox']).toBeUndefined();

    authRequestId = auth.authRequestId;
    consentUrl = auth.consentUrl;
    expect(consentUrl).toMatch(new RegExp(`^${PUBLIC_BASE_URL}/consent\\?req=`));
  });

  it('GET consentUrl on grantex.dev returns the consent HTML page', async () => {
    const res = await fetch(consentUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    // Distinctive markers from the server-rendered CONSENT_HTML template.
    expect(body).toContain('Authorization Request');
    expect(body).toContain('/v1/consent/');
    expect(body).toContain('/v1/webauthn/assert/options');
    expect(body).toContain('navigator.credentials.get');
  });

  it('GET /v1/consent/:id on grantex.dev returns the request details', async () => {
    const res = await fetch(`${PUBLIC_BASE_URL}/v1/consent/${authRequestId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      agentName: string;
      agentDid: string;
      scopes: string[];
      status: string;
    };
    expect(body.id).toBe(authRequestId);
    expect(body.scopes).toEqual(expect.arrayContaining(['calendar:read', 'email:send']));
    expect(body.status).toBe('pending');
    expect(body.agentDid).toMatch(/^did:/);
  });

  it('POST /v1/consent/:id/approve on grantex.dev requires principal verification', async () => {
    const res = await fetch(`${PUBLIC_BASE_URL}/v1/consent/${authRequestId}/approve`, {
      method: 'POST',
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('PRINCIPAL_VERIFICATION_REQUIRED');
  });

  it('POST /v1/webauthn/assert/options starts the live verification path', async () => {
    const res = await fetch(`${PUBLIC_BASE_URL}/v1/webauthn/assert/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authRequestId }),
    });
    // This test account has not registered a passkey. The JSON response proves
    // Firebase routed the hosted page's assertion request to the auth service.
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { message?: string; code?: string };
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toMatch(/No FIDO credentials/);
  });
});

describe('live-mode: deny flow', () => {
  it('POST /v1/consent/:id/deny on grantex.dev requires principal verification', async () => {
    const auth = await grantex.authorize({
      agentId: mainAgentId,
      userId: `principal-deny-${Date.now()}`,
      scopes: ['calendar:read'],
    });
    expect((auth as Record<string, unknown>)['code']).toBeUndefined();

    const denyRes = await fetch(`${PUBLIC_BASE_URL}/v1/consent/${auth.authRequestId}/deny`, {
      method: 'POST',
    });
    expect(denyRes.status).toBe(403);

    // The request remains pending until a verified browser ceremony succeeds.
    const body = (await denyRes.json()) as { code?: string };
    expect(body.code).toBe('PRINCIPAL_VERIFICATION_REQUIRED');
  });
});
