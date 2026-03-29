import { describe, it, expect, vi, afterEach } from 'vitest';
import { Grantex } from '../src/client.js';

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const MOCK_SSO_CONFIG = {
  issuerUrl: 'https://idp.example.com',
  clientId: 'client_abc',
  redirectUri: 'https://app.grantex.dev/sso/callback',
  createdAt: '2026-02-27T00:00:00Z',
  updatedAt: '2026-02-27T00:00:00Z',
};

const MOCK_OIDC_CONNECTION = {
  id: 'sso_CONN01',
  developerId: 'dev_TEST',
  name: 'Okta OIDC',
  protocol: 'oidc' as const,
  status: 'active' as const,
  issuerUrl: 'https://idp.example.com',
  clientId: 'client_abc',
  domains: ['corp.com'],
  jitProvisioning: true,
  enforce: false,
  groupAttribute: 'groups',
  groupMappings: { Engineering: ['read', 'write'] },
  defaultScopes: ['read'],
  createdAt: '2026-03-29T00:00:00Z',
  updatedAt: '2026-03-29T00:00:00Z',
};

const MOCK_SESSION = {
  id: 'ssosess_01',
  connectionId: 'sso_CONN01',
  principalId: 'scimuser_01',
  email: 'alice@corp.com',
  name: 'Alice Smith',
  idpSubject: 'idp_user_01',
  groups: ['Engineering'],
  mappedScopes: ['read', 'write'],
  expiresAt: '2026-03-30T00:00:00Z',
  createdAt: '2026-03-29T00:00:00Z',
};

describe('SsoClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Connections CRUD ─────────────────────────────────────────────────

  it('createConnection() POSTs to /v1/sso/connections', async () => {
    const mockFetch = makeFetch(201, MOCK_OIDC_CONNECTION);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.createConnection({
      name: 'Okta OIDC',
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client_abc',
      clientSecret: 'secret_xyz',
      domains: ['corp.com'],
      jitProvisioning: true,
    });

    expect(result.id).toBe('sso_CONN01');
    expect(result.protocol).toBe('oidc');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/connections$/);
    expect(init.method).toBe('POST');
  });

  it('listConnections() GETs /v1/sso/connections', async () => {
    const mockFetch = makeFetch(200, { connections: [MOCK_OIDC_CONNECTION] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.listConnections();

    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].name).toBe('Okta OIDC');
  });

  it('getConnection() GETs /v1/sso/connections/:id', async () => {
    const mockFetch = makeFetch(200, MOCK_OIDC_CONNECTION);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.getConnection('sso_CONN01');

    expect(result.id).toBe('sso_CONN01');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/connections\/sso_CONN01$/);
  });

  it('updateConnection() PATCHes /v1/sso/connections/:id', async () => {
    const mockFetch = makeFetch(200, { ...MOCK_OIDC_CONNECTION, name: 'Updated' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.updateConnection('sso_CONN01', { name: 'Updated' });

    expect(result.name).toBe('Updated');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/connections\/sso_CONN01$/);
    expect(init.method).toBe('PATCH');
  });

  it('deleteConnection() DELETEs /v1/sso/connections/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.sso.deleteConnection('sso_CONN01');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/connections\/sso_CONN01$/);
    expect(init.method).toBe('DELETE');
  });

  it('testConnection() POSTs to /v1/sso/connections/:id/test', async () => {
    const mockFetch = makeFetch(200, { success: true, protocol: 'oidc', issuer: 'https://idp.example.com' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.testConnection('sso_CONN01');

    expect(result.success).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/connections\/sso_CONN01\/test$/);
    expect(init.method).toBe('POST');
  });

  // ── Enforcement ──────────────────────────────────────────────────────

  it('setEnforcement() POSTs to /v1/sso/enforce', async () => {
    const mockFetch = makeFetch(200, { enforce: true, developerId: 'dev_TEST' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.setEnforcement({ enforce: true });

    expect(result.enforce).toBe(true);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/enforce$/);
    expect(init.method).toBe('POST');
  });

  // ── Sessions ─────────────────────────────────────────────────────────

  it('listSessions() GETs /v1/sso/sessions', async () => {
    const mockFetch = makeFetch(200, { sessions: [MOCK_SESSION] });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.listSessions();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].email).toBe('alice@corp.com');
  });

  it('revokeSession() DELETEs /v1/sso/sessions/:id', async () => {
    const mockFetch = makeFetch(204, null);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    await grantex.sso.revokeSession('ssosess_01');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/sessions\/ssosess_01$/);
    expect(init.method).toBe('DELETE');
  });

  // ── Login flow ───────────────────────────────────────────────────────

  it('getLoginUrl() includes domain param when provided', async () => {
    const mockFetch = makeFetch(200, { authorizeUrl: 'https://idp.example.com/authorize', protocol: 'oidc', connectionId: 'sso_CONN01' });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.getLoginUrl('dev_TEST', 'corp.com');

    expect(result.authorizeUrl).toContain('idp.example.com');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('org=dev_TEST');
    expect(url).toContain('domain=corp.com');
  });

  it('handleOidcCallback() POSTs to /sso/callback/oidc', async () => {
    const mockResult = {
      sessionId: 'ssosess_01',
      email: 'alice@corp.com',
      name: 'Alice Smith',
      sub: 'idp_user_01',
      groups: ['Engineering'],
      mappedScopes: ['read', 'write'],
      principalId: 'scimuser_01',
      developerId: 'dev_TEST',
      expiresAt: '2026-03-30T00:00:00Z',
    };
    const mockFetch = makeFetch(200, mockResult);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.handleOidcCallback({ code: 'abc', state: 'state123' });

    expect(result.sessionId).toBe('ssosess_01');
    expect(result.email).toBe('alice@corp.com');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sso\/callback\/oidc$/);
    expect(init.method).toBe('POST');
  });

  it('handleSamlCallback() POSTs to /sso/callback/saml', async () => {
    const mockResult = {
      sessionId: 'ssosess_02',
      email: 'bob@corp.com',
      name: 'Bob Jones',
      sub: 'saml_user_01',
      groups: ['Admins'],
      mappedScopes: ['admin'],
      principalId: 'scimuser_02',
      developerId: 'dev_TEST',
      expiresAt: '2026-03-30T00:00:00Z',
    };
    const mockFetch = makeFetch(200, mockResult);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.handleSamlCallback({ SAMLResponse: 'base64data', RelayState: 'state123' });

    expect(result.sessionId).toBe('ssosess_02');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/sso\/callback\/saml$/);
    expect(init.method).toBe('POST');
  });

  // ── Legacy methods ───────────────────────────────────────────────────

  it('createConfig() POSTs to /v1/sso/config (legacy)', async () => {
    const mockFetch = makeFetch(201, MOCK_SSO_CONFIG);
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.createConfig({
      issuerUrl: 'https://idp.example.com',
      clientId: 'client_abc',
      clientSecret: 'secret_xyz',
      redirectUri: 'https://app.grantex.dev/sso/callback',
    });

    expect(result.issuerUrl).toBe('https://idp.example.com');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/v1\/sso\/config$/);
    expect(init.method).toBe('POST');
  });

  it('handleCallback() GETs /sso/callback (legacy)', async () => {
    const mockFetch = makeFetch(200, {
      email: 'alice@corp.com',
      name: 'Alice Smith',
      sub: 'idp_user_01',
      developerId: 'dev_TEST',
    });
    vi.stubGlobal('fetch', mockFetch);

    const grantex = new Grantex({ apiKey: 'test_key' });
    const result = await grantex.sso.handleCallback('auth_code_xyz', 'state_abc');

    expect(result.email).toBe('alice@corp.com');
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sso/callback');
    expect(url).toContain('code=auth_code_xyz');
  });
});
