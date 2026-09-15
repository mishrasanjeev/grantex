import { createHash } from 'node:crypto';
import * as jose from 'jose';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { InMemoryStorage } from '../src/storage/memory.js';
import { hashClientSecret } from '../src/lib/verify.js';
import type { ClientRegistration, McpAuthConfig } from '../src/types.js';

export const TEST_CLIENT_ID = 'test-client-id';
export const TEST_CLIENT_SECRET = 'test-secret';
export const TEST_REDIRECT_URI = 'https://app.example.com/callback';
export const TEST_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
export const TEST_CHALLENGE = createHash('sha256').update(TEST_VERIFIER).digest('base64url');
/** Canonical URI of the MCP server the test authorization server issues tokens for. */
export const TEST_RESOURCE = 'https://mcp.example.com/mcp';

/**
 * An unsigned JWT shaped like a Grantex grant token. The authorization server
 * only decodes the token it receives from Grantex (to check its audience), so
 * the tests do not need to sign it.
 */
export function upstreamGrantToken(claims: Record<string, unknown> = {}): string {
  return new jose.UnsecuredJWT({ aud: TEST_RESOURCE, jti: 'grnt_upstream', scp: ['read', 'write'], ...claims })
    .setIssuedAt()
    .setExpirationTime('1h')
    .encode();
}

/**
 * A registration as the server stores it. Pass `clientSecret` to register a
 * confidential client (only its hash is stored) or `publicClient: true` for a
 * PKCE-only client.
 */
export function clientRecord(
  options: Partial<Omit<ClientRegistration, 'clientSecretHash'>> & { clientSecret?: string; publicClient?: boolean } = {},
): ClientRegistration {
  const { clientSecret, publicClient, ...rest } = options;
  return {
    clientId: TEST_CLIENT_ID,
    redirectUris: [TEST_REDIRECT_URI],
    grantTypes: ['authorization_code'],
    createdAt: new Date().toISOString(),
    ...(publicClient
      ? { tokenEndpointAuthMethod: 'none' as const }
      : { tokenEndpointAuthMethod: 'client_secret_basic' as const, clientSecretHash: hashClientSecret(clientSecret ?? TEST_CLIENT_SECRET) }),
    ...rest,
  };
}

/** Storage seeded with the given client registrations. */
export async function seededStorage(...clients: ClientRegistration[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  for (const client of clients) await storage.putClient(client);
  return storage;
}

export interface MockGrantex {
  authorize: Mock;
  tokens: { exchange: Mock; refresh: Mock; revoke: Mock };
}

export function mockGrantex(options: { sandboxCode?: string } = {}): MockGrantex {
  return {
    authorize: vi.fn().mockResolvedValue({
      authRequestId: 'auth-req-1',
      consentUrl: 'https://grantex.example.com/consent',
      agentId: 'agent-1',
      principalId: 'principal-1',
      scopes: ['read', 'write'],
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: options.sandboxCode ? ('approved' as const) : ('pending' as const),
      createdAt: new Date().toISOString(),
      ...(options.sandboxCode ? { sandbox: true, code: options.sandboxCode } : {}),
    }),
    tokens: {
      exchange: vi.fn().mockResolvedValue({
        grantToken: upstreamGrantToken({ jti: 'gt_test_token' }),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_test_refresh',
        grantId: 'grant-1',
      }),
      refresh: vi.fn().mockResolvedValue({
        grantToken: upstreamGrantToken({ jti: 'gt_refreshed_token' }),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        scopes: ['read', 'write'],
        refreshToken: 'rt_new_refresh',
        grantId: 'grant-1',
      }),
      revoke: vi.fn().mockResolvedValue(undefined),
    },
  };
}

export function asGrantex(mock: MockGrantex): McpAuthConfig['grantex'] {
  return mock as unknown as McpAuthConfig['grantex'];
}

interface InjectResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | number | undefined>;
}

interface Injector {
  inject(options: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: string;
  }): Promise<InjectResponse>;
}

/** Reads the consent form fields and the browser-binding cookie from a rendered consent page. */
export function consentFormFrom(page: InjectResponse): { consentId: string; csrfToken: string; cookie: string } {
  const consentId = /name="consent_id" value="([^"]+)"/.exec(page.body)?.[1];
  const csrfToken = /name="csrf_token" value="([^"]+)"/.exec(page.body)?.[1];
  const setCookie = page.headers['set-cookie'];
  const cookie = String((Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? '').split(';')[0];
  if (!consentId || !csrfToken || !cookie) {
    throw new Error(`not a consent page (status ${page.statusCode})`);
  }
  return { consentId, csrfToken, cookie };
}

/**
 * Submits the consent page as the browser would: same-origin form post with
 * the page's cookie. `/authorize` renders this page for every valid request.
 */
export function submitConsent(
  app: Injector,
  page: InjectResponse,
  decision: 'approve' | 'deny' = 'approve',
  issuer = 'https://auth.example.com',
): Promise<InjectResponse> {
  const { consentId, csrfToken, cookie } = consentFormFrom(page);
  return app.inject({
    method: 'POST',
    url: '/consent',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: new URL(issuer).origin,
      'sec-fetch-site': 'same-origin',
    },
    payload: new URLSearchParams({ consent_id: consentId, csrf_token: csrfToken, decision }).toString(),
  });
}

/**
 * GET /authorize and, when it renders the consent page, approve it the way
 * a browser would. Validation errors (400) are returned as they are, so a
 * test can use this wherever it used to call /authorize directly; a success
 * is now the 303 that follows the consent form.
 */
export async function authorizeWithConsent(app: FastifyInstance, options: InjectOptions): Promise<LightMyRequestResponse> {
  const page = await app.inject(options);
  if (page.statusCode !== 200) return page;
  const { consentId, csrfToken, cookie } = consentFormFrom(page);
  return app.inject({
    method: 'POST',
    url: '/consent',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'sec-fetch-site': 'same-origin' },
    payload: new URLSearchParams({ consent_id: consentId, csrf_token: csrfToken, decision: 'approve' }).toString(),
  });
}

/**
 * The callback-binding cookie (`name=value`) that approving the consent page
 * sets. `/callback` issues a code only when the browser presents it.
 */
export function callbackCookieFrom(response: { headers: Record<string, string | string[] | number | undefined> }): string {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  const pair = cookies
    .map((cookie) => cookie.split(';')[0]!)
    .find((cookie) => /mcp_auth_callback_[A-Za-z0-9_-]{16}=[^;]+$/.test(cookie));
  if (!pair) throw new Error('no callback-binding cookie was set');
  return pair;
}
