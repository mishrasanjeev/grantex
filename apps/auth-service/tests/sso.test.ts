import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

// ── Mock the SSO library so routes are tested in isolation ────────────────
vi.mock('../src/lib/sso.js', () => ({
  discoverOidcProvider: vi.fn().mockResolvedValue({
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
  }),
  verifyIdToken: vi.fn().mockResolvedValue({
    sub: 'idp_user_01',
    email: 'alice@corp.com',
    name: 'Alice Smith',
    groups: ['Engineering'],
  }),
  parseSamlResponse: vi.fn().mockReturnValue({
    sub: 'saml_user_01',
    email: 'bob@corp.com',
    name: 'Bob Jones',
    groups: ['Admins'],
  }),
  resolveConnection: vi.fn(),
  mapGroupsToScopes: vi.fn().mockReturnValue(['read', 'write']),
  jitProvision: vi.fn().mockResolvedValue('scimuser_JIT01'),
  createSsoSession: vi.fn().mockResolvedValue({
    id: 'ssosess_MOCK01',
    developer_id: 'dev_TEST',
    connection_id: 'sso_CONN01',
    principal_id: 'scimuser_JIT01',
    email: 'alice@corp.com',
    name: 'Alice Smith',
    idp_subject: 'idp_user_01',
    groups: ['Engineering'],
    mapped_scopes: ['read', 'write'],
    expires_at: '2026-03-30T00:00:00.000Z',
    created_at: '2026-03-29T00:00:00.000Z',
  }),
  clearDiscoveryCache: vi.fn(),
  clearJwksCache: vi.fn(),
}));

import {
  resolveConnection,
  verifyIdToken,
  parseSamlResponse,
} from '../src/lib/sso.js';

const mockedResolveConnection = vi.mocked(resolveConnection);
const mockedVerifyIdToken = vi.mocked(verifyIdToken);
const mockedParseSamlResponse = vi.mocked(parseSamlResponse);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  mockedResolveConnection.mockReset();
  mockedVerifyIdToken.mockReset().mockResolvedValue({
    sub: 'idp_user_01',
    email: 'alice@corp.com',
    name: 'Alice Smith',
    groups: ['Engineering'],
  });
  mockedParseSamlResponse.mockReset().mockReturnValue({
    sub: 'saml_user_01',
    email: 'bob@corp.com',
    name: 'Bob Jones',
    groups: ['Admins'],
  });
});

// ─── Mock DB rows ──────────────────────────────────────────────────────────

const LDAP_NULL_FIELDS = {
  ldap_url: null,
  ldap_bind_dn: null,
  ldap_bind_password: null,
  ldap_search_base: null,
  ldap_search_filter: null,
  ldap_group_search_base: null,
  ldap_group_search_filter: null,
  ldap_tls_enabled: false,
};

const OIDC_CONNECTION_ROW = {
  id: 'sso_CONN01',
  developer_id: 'dev_TEST',
  name: 'Okta OIDC',
  protocol: 'oidc',
  status: 'active',
  issuer_url: 'https://idp.example.com',
  client_id: 'client_abc',
  client_secret: 'secret_xyz',
  idp_entity_id: null,
  idp_sso_url: null,
  idp_certificate: null,
  sp_entity_id: null,
  sp_acs_url: null,
  ...LDAP_NULL_FIELDS,
  domains: ['corp.com'],
  jit_provisioning: true,
  enforce: false,
  group_attribute: 'groups',
  group_mappings: { Engineering: ['read', 'write'] },
  default_scopes: ['read'],
  created_at: '2026-03-29T00:00:00Z',
  updated_at: '2026-03-29T00:00:00Z',
};

const SAML_CONNECTION_ROW = {
  ...OIDC_CONNECTION_ROW,
  id: 'sso_CONN02',
  name: 'Azure AD SAML',
  protocol: 'saml',
  issuer_url: null,
  client_id: null,
  client_secret: null,
  idp_entity_id: 'https://sts.windows.net/tenant-id/',
  idp_sso_url: 'https://login.microsoftonline.com/tenant-id/saml2',
  idp_certificate: 'MIICnTCCAYUCBgF...',
  sp_entity_id: 'urn:grantex:corp',
  sp_acs_url: 'https://app.grantex.dev/sso/callback/saml',
  domains: ['corp.com'],
};

const SSO_CONFIG_ROW = {
  developer_id: 'dev_TEST',
  issuer_url: 'https://idp.example.com',
  client_id: 'client_abc',
  client_secret: 'secret_xyz',
  redirect_uri: 'https://app.grantex.dev/sso/callback',
  created_at: '2026-02-27T00:00:00Z',
  updated_at: '2026-02-27T00:00:00Z',
};

const SSO_SESSION_ROW = {
  id: 'ssosess_SESS01',
  developer_id: 'dev_TEST',
  connection_id: 'sso_CONN01',
  principal_id: 'scimuser_JIT01',
  email: 'alice@corp.com',
  name: 'Alice Smith',
  idp_subject: 'idp_user_01',
  groups: ['Engineering'],
  mapped_scopes: ['read', 'write'],
  expires_at: '2026-03-30T00:00:00Z',
  created_at: '2026-03-29T00:00:00Z',
};

const LDAP_CONNECTION_ROW = {
  ...OIDC_CONNECTION_ROW,
  id: 'sso_CONN03',
  name: 'Corp LDAP',
  protocol: 'ldap',
  issuer_url: null,
  client_id: null,
  client_secret: null,
  ldap_url: 'ldap://ldap.corp.com:389',
  ldap_bind_dn: 'cn=admin,dc=corp,dc=com',
  ldap_bind_password: 'admin-secret',
  ldap_search_base: 'ou=people,dc=corp,dc=com',
  ldap_search_filter: '(uid={{username}})',
  ldap_group_search_base: 'ou=groups,dc=corp,dc=com',
  ldap_group_search_filter: '(member={{dn}})',
  ldap_tls_enabled: false,
  domains: ['corp.com'],
};

// ═══════════════════════════════════════════════════════════════════════════
// SSO Connections CRUD
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /v1/sso/connections', () => {
  it('creates an OIDC connection and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]); // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {
        name: 'Okta OIDC',
        protocol: 'oidc',
        issuerUrl: 'https://idp.example.com',
        clientId: 'client_abc',
        clientSecret: 'secret_xyz',
        domains: ['corp.com'],
        jitProvisioning: true,
        groupAttribute: 'groups',
        groupMappings: { Engineering: ['read', 'write'] },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('Okta OIDC');
    expect(body.protocol).toBe('oidc');
    expect(body.issuerUrl).toBe('https://idp.example.com');
    expect(body.domains).toEqual(['corp.com']);
    expect(body.jitProvisioning).toBe(true);
  });

  it('creates a SAML connection and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([SAML_CONNECTION_ROW]); // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {
        name: 'Azure AD SAML',
        protocol: 'saml',
        idpEntityId: 'https://sts.windows.net/tenant-id/',
        idpSsoUrl: 'https://login.microsoftonline.com/tenant-id/saml2',
        idpCertificate: 'MIICnTCCAYUCBgF...',
        spEntityId: 'urn:grantex:corp',
        spAcsUrl: 'https://app.grantex.dev/sso/callback/saml',
        domains: ['corp.com'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.protocol).toBe('saml');
    expect(body.idpEntityId).toBe('https://sts.windows.net/tenant-id/');
  });

  it('returns 400 when name or protocol missing', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { protocol: 'oidc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid protocol', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { name: 'Test', protocol: 'ldap' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when OIDC missing required fields', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { name: 'Test', protocol: 'oidc', issuerUrl: 'https://idp.example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('clientId');
  });

  it('returns 400 when SAML missing required fields', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { name: 'Test', protocol: 'saml', idpEntityId: 'urn:test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('idpSsoUrl');
  });
});

describe('GET /v1/sso/connections', () => {
  it('lists all connections for the org', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW, SAML_CONNECTION_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/connections',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connections).toHaveLength(2);
    expect(body.connections[0].protocol).toBe('oidc');
    expect(body.connections[1].protocol).toBe('saml');
  });

  it('returns empty array when no connections exist', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/connections',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().connections).toEqual([]);
  });
});

describe('GET /v1/sso/connections/:id', () => {
  it('returns a single connection', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/connections/sso_CONN01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('sso_CONN01');
  });

  it('returns 404 when connection not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/connections/sso_NOTEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/sso/connections/:id', () => {
  it('updates connection fields and returns updated row', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]); // SELECT existing
    sqlMock.mockResolvedValueOnce([{ ...OIDC_CONNECTION_ROW, name: 'Updated Name', status: 'testing' }]); // UPDATE

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/sso/connections/sso_CONN01',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { name: 'Updated Name', status: 'testing' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated Name');
  });

  it('returns 400 when no fields to update', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/sso/connections/sso_CONN01',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when connection not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // SELECT existing returns empty

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/sso/connections/sso_NOTEXIST',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { name: 'Test' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/sso/connections/:id', () => {
  it('deletes connection and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'sso_CONN01' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/connections/sso_CONN01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when connection not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/connections/sso_NOTEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/sso/connections/:id/test', () => {
  it('tests OIDC connection via discovery', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections/sso_CONN01/test',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().protocol).toBe('oidc');
  });

  it('returns 404 when connection not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections/sso_NOTEXIST/test',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SSO enforcement
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /v1/sso/enforce', () => {
  it('enables SSO enforcement', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // UPDATE sso_connections

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/enforce',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { enforce: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().enforce).toBe(true);
  });

  it('returns 400 when enforce not boolean', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/enforce',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { enforce: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SSO sessions
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /v1/sso/sessions', () => {
  it('lists active SSO sessions', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([SSO_SESSION_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/sessions',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].email).toBe('alice@corp.com');
    expect(body.sessions[0].connectionId).toBe('sso_CONN01');
  });
});

describe('DELETE /v1/sso/sessions/:id', () => {
  it('revokes a session and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'ssosess_SESS01' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/sessions/ssosess_SESS01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when session not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/sessions/ssosess_NOTEXIST',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SSO login flow (public)
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /sso/login (enterprise)', () => {
  it('returns OIDC authorize URL via discovery', async () => {
    mockedResolveConnection.mockResolvedValueOnce(OIDC_CONNECTION_ROW as any);

    const res = await app.inject({
      method: 'GET',
      url: '/sso/login?org=dev_TEST&domain=corp.com',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authorizeUrl).toContain('idp.example.com');
    expect(body.protocol).toBe('oidc');
    expect(body.connectionId).toBe('sso_CONN01');
  });

  it('returns SAML redirect URL for SAML connections', async () => {
    mockedResolveConnection.mockResolvedValueOnce(SAML_CONNECTION_ROW as any);

    const res = await app.inject({
      method: 'GET',
      url: '/sso/login?org=dev_TEST&domain=corp.com',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.authorizeUrl).toContain('login.microsoftonline.com');
    expect(body.protocol).toBe('saml');
    expect(body.authorizeUrl).toContain('SAMLRequest=');
  });

  it('returns 400 when org missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sso/login',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when no SSO connection found', async () => {
    mockedResolveConnection.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'GET',
      url: '/sso/login?org=dev_UNKNOWN',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// OIDC callback (enterprise)
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /sso/callback/oidc', () => {
  const state = Buffer.from(JSON.stringify({ org: 'dev_TEST', connectionId: 'sso_CONN01' })).toString('base64url');

  it('exchanges code, verifies ID token, creates session', async () => {
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]); // SELECT connection

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: 'mock.id.token', access_token: 'at_xxx' }),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state, redirect_uri: 'https://app.test/callback' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe('ssosess_MOCK01');
    expect(body.email).toBe('alice@corp.com');
    expect(body.name).toBe('Alice Smith');
    expect(body.mappedScopes).toEqual(['read', 'write']);
    expect(body.principalId).toBe('scimuser_JIT01');
    expect(body.developerId).toBe('dev_TEST');
  });

  it('returns 400 when code or state missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid state', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'abc', state: '!!!invalid!!!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when connection not found', async () => {
    sqlMock.mockResolvedValueOnce([]); // No connection

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'abc', state },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 502 when token exchange fails', async () => {
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 400 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'bad_code', state },
    });
    expect(res.statusCode).toBe(502);
  });

  it('returns 502 when ID token verification fails', async () => {
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);
    mockedVerifyIdToken.mockRejectedValueOnce(new Error('Invalid signature'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: 'bad.token.sig', access_token: 'at_xxx' }),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'abc', state },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('ID token verification failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SAML callback
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /sso/callback/saml', () => {
  const relayState = Buffer.from(JSON.stringify({ org: 'dev_TEST', connectionId: 'sso_CONN02' })).toString('base64url');

  it('parses SAML response, creates session', async () => {
    sqlMock.mockResolvedValueOnce([SAML_CONNECTION_ROW]); // SELECT connection

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/saml',
      headers: { 'content-type': 'application/json' },
      payload: { SAMLResponse: Buffer.from('<saml>mock</saml>').toString('base64'), RelayState: relayState },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe('ssosess_MOCK01');
    expect(body.email).toBe('bob@corp.com');
    expect(body.sub).toBe('saml_user_01');
    expect(body.developerId).toBe('dev_TEST');
  });

  it('returns 400 when SAMLResponse or RelayState missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/saml',
      headers: { 'content-type': 'application/json' },
      payload: { SAMLResponse: 'abc' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid RelayState', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/saml',
      headers: { 'content-type': 'application/json' },
      payload: { SAMLResponse: 'abc', RelayState: '!!!bad!!!' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when SAML connection not found', async () => {
    sqlMock.mockResolvedValueOnce([]); // No connection

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/saml',
      headers: { 'content-type': 'application/json' },
      payload: { SAMLResponse: 'abc', RelayState: relayState },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 502 when SAML verification fails', async () => {
    sqlMock.mockResolvedValueOnce([SAML_CONNECTION_ROW]);
    mockedParseSamlResponse.mockImplementationOnce(() => {
      throw new Error('SAML Response signature verification failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/saml',
      headers: { 'content-type': 'application/json' },
      payload: { SAMLResponse: 'abc', RelayState: relayState },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('SAML Response signature verification failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Legacy endpoints (backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /v1/sso/config (legacy)', () => {
  it('creates SSO config and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/config',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {
        issuerUrl: 'https://idp.example.com',
        clientId: 'client_abc',
        clientSecret: 'secret_xyz',
        redirectUri: 'https://app.grantex.dev/sso/callback',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().issuerUrl).toBe('https://idp.example.com');
  });

  it('returns 400 when required fields missing', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/config',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { issuerUrl: 'https://idp.example.com' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/sso/config (legacy)', () => {
  it('returns SSO config without client secret', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/config',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().clientSecret).toBeUndefined();
  });

  it('returns 404 when not configured', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/sso/config',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /v1/sso/config (legacy)', () => {
  it('removes SSO config and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ developer_id: 'dev_TEST' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/sso/config',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('GET /sso/callback (legacy)', () => {
  it('exchanges code and returns user info', async () => {
    const state = Buffer.from(JSON.stringify({ org: 'dev_TEST' })).toString('base64url');
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    const idTokenPayload = Buffer.from(
      JSON.stringify({ sub: 'idp_user_01', email: 'alice@corp.com', name: 'Alice Smith' }),
    ).toString('base64url');
    const mockIdToken = `header.${idTokenPayload}.sig`;

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: mockIdToken, access_token: 'at_xxx' }),
      }),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=auth_code_xyz&state=${state}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('alice@corp.com');
    expect(res.json().developerId).toBe('dev_TEST');
  });

  it('returns 502 when IdP token exchange fails', async () => {
    const state = Buffer.from(JSON.stringify({ org: 'dev_TEST' })).toString('base64url');
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=bad_code&state=${state}`,
    });
    expect(res.statusCode).toBe(502);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LDAP
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /v1/sso/connections (LDAP)', () => {
  it('creates an LDAP connection and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([LDAP_CONNECTION_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: {
        name: 'Corp LDAP',
        protocol: 'ldap',
        ldapUrl: 'ldap://ldap.corp.com:389',
        ldapBindDn: 'cn=admin,dc=corp,dc=com',
        ldapBindPassword: 'admin-secret',
        ldapSearchBase: 'ou=people,dc=corp,dc=com',
        domains: ['corp.com'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.protocol).toBe('ldap');
    expect(body.ldapUrl).toBe('ldap://ldap.corp.com:389');
    expect(body.ldapSearchBase).toBe('ou=people,dc=corp,dc=com');
  });

  it('returns 400 when LDAP missing required fields', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      payload: { name: 'Test', protocol: 'ldap', ldapUrl: 'ldap://host' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('ldapBindDn');
  });
});

describe('POST /v1/sso/connections/:id/test (LDAP)', () => {
  it('tests LDAP connectivity', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([LDAP_CONNECTION_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/sso/connections/sso_CONN03/test',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().protocol).toBe('ldap');
  });
});

describe('GET /sso/login (LDAP)', () => {
  it('returns LDAP info instead of redirect URL', async () => {
    mockedResolveConnection.mockResolvedValueOnce(LDAP_CONNECTION_ROW as any);

    const res = await app.inject({
      method: 'GET',
      url: '/sso/login?org=dev_TEST&domain=corp.com',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.protocol).toBe('ldap');
    expect(body.connectionId).toBe('sso_CONN03');
    expect(body.ldapUrl).toBe('ldap://ldap.corp.com:389');
  });
});

describe('POST /sso/callback/ldap', () => {
  it('authenticates user via LDAP and creates session', async () => {
    sqlMock.mockResolvedValueOnce([LDAP_CONNECTION_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/ldap',
      headers: { 'content-type': 'application/json' },
      payload: {
        username: 'alice',
        password: 'alice-secret',
        connectionId: 'sso_CONN03',
        org: 'dev_TEST',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe('ssosess_MOCK01');
    expect(body.email).toBe('alice@corp.com');
    expect(body.name).toBe('Alice Smith');
    expect(body.developerId).toBe('dev_TEST');
    expect(body.mappedScopes).toEqual(['read', 'write']);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/ldap',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'alice' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when LDAP connection not found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/ldap',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'alice', password: 'pass', connectionId: 'sso_NOPE', org: 'dev_TEST' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 when LDAP auth fails', async () => {
    sqlMock.mockResolvedValueOnce([LDAP_CONNECTION_ROW]);

    // Mock authenticateLdap to fail (it's mocked in setup.ts, override here)
    const { authenticateLdap } = await import('../src/lib/ldap.js');
    vi.mocked(authenticateLdap).mockRejectedValueOnce(new Error('Invalid LDAP credentials'));

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/ldap',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'alice', password: 'wrong', connectionId: 'sso_CONN03', org: 'dev_TEST' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe('Invalid LDAP credentials');
  });
});
