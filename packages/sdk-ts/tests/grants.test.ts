import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

// Mock jose so verify.ts doesn't try to fetch JWKS
vi.mock('jose', () => ({
  jwtVerify: vi.fn(),
  decodeJwt: vi.fn(),
  createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
}));

import * as jose from 'jose';

const MOCK_GRANT = {
  id: 'grant_01',
  agentId: 'ag_01',
  agentDid: 'did:grantex:ag_01',
  principalId: 'user_abc',
  developerId: 'org_1',
  scopes: ['calendar:read'],
  status: 'active' as const,
  issuedAt: '2026-02-01T00:00:00Z',
  expiresAt: '2026-02-02T00:00:00Z',
};

const MOCK_PAYLOAD = {
  iss: 'https://grantex.dev',
  sub: 'user_abc',
  agt: 'did:grantex:ag_01',
  dev: 'org_1',
  scp: ['calendar:read'],
  iat: 1700000000,
  exp: 1700086400,
  jti: 'tok_01',
  grnt: 'grant_01',
};

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe('GrantsClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('get() GETs /v1/grants/:id', async () => {
    vi.stubGlobal('fetch', makeFetch(200, MOCK_GRANT));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const grant = await grantex.grants.get('grant_01');

    expect(grant.id).toBe('grant_01');
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toMatch(/\/v1\/grants\/grant_01$/);
  });

  it('list() GETs /v1/grants', async () => {
    const listResponse = { grants: [MOCK_GRANT], total: 1, page: 1, pageSize: 20 };
    vi.stubGlobal('fetch', makeFetch(200, listResponse));

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.grants.list();

    expect(result.grants).toHaveLength(1);
  });

  it('list() appends query params', async () => {
    const listResponse = { grants: [], total: 0, page: 1, pageSize: 20 };
    const mockFetch = makeFetch(200, listResponse);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.grants.list({ agentId: 'ag_01', status: 'active' });

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('agentId=ag_01');
    expect(url).toContain('status=active');
  });

  it('revoke() DELETEs /v1/grants/:id', async () => {
    vi.stubGlobal('fetch', makeFetch(204, null));

    const grantex = new Grantex({ apiKey: 'test_key' });
    await expect(grantex.grants.revoke('grant_01')).resolves.toBeUndefined();

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
  });

  it('verify() returns VerifiedGrant using decoded token', async () => {
    const serverResponse = { token: 'fake.jwt.token' };
    vi.stubGlobal('fetch', makeFetch(200, serverResponse));
    vi.mocked(jose.decodeJwt).mockReturnValue(MOCK_PAYLOAD as never);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.grants.verify('fake.jwt.token');

    expect(result.principalId).toBe('user_abc');
    expect(result.scopes).toEqual(['calendar:read']);
    expect(result.grantId).toBe('grant_01');
  });
});
