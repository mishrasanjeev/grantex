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
  generateSamlAuthorizeUrl: vi.fn().mockResolvedValue(
    'https://login.microsoftonline.com/tenant-id/saml2?SAMLRequest=mock&RelayState=mock',
  ),
  parseSamlResponse: vi.fn().mockResolvedValue({
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
  // OIDC nonce + PKCE binding. The default discovery mock above advertises no
  // code_challenge_methods_supported, so PKCE stays off unless a test opts in.
  saveOidcAuthRequest: vi.fn().mockResolvedValue(undefined),
  consumeOidcAuthRequest: vi.fn().mockResolvedValue(null),
  supportsPkceS256: vi.fn().mockReturnValue(false),
}));

import {
  resolveConnection,
  verifyIdToken,
  parseSamlResponse,
  saveOidcAuthRequest,
  consumeOidcAuthRequest,
  supportsPkceS256,
} from '../src/lib/sso.js';
import { encrypt } from '../src/lib/vault-crypto.js';
import { createHash } from 'node:crypto';
import { setSafeFetchForTests } from '../src/lib/url-security.js';
import { signSsoState, verifySsoState } from '../src/routes/sso.js';

const mockedResolveConnection = vi.mocked(resolveConnection);
const mockedVerifyIdToken = vi.mocked(verifyIdToken);
const mockedParseSamlResponse = vi.mocked(parseSamlResponse);
const mockedSaveOidcAuthRequest = vi.mocked(saveOidcAuthRequest);
const mockedConsumeOidcAuthRequest = vi.mocked(consumeOidcAuthRequest);
const mockedSupportsPkceS256 = vi.mocked(supportsPkceS256);

let app: FastifyInstance;

// Every OIDC login is bound to a stored nonce/PKCE entry, so the callback
// fixtures carry a request id and the IdP echoes the nonce back.
const OIDC_REQUEST_ID = 'reqfixture00000000000000';
const OIDC_NONCE = 'fixture-nonce';

function encryptedSsoSecret(value: string): string {
  return `vault:v1:${encrypt(value)}`;
}

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSafeFetchForTests(null);
  mockedResolveConnection.mockReset();
  mockedVerifyIdToken.mockReset().mockResolvedValue({
    sub: 'idp_user_01',
    email: 'alice@corp.com',
    name: 'Alice Smith',
    groups: ['Engineering'],
    nonce: OIDC_NONCE,
  });
  mockedSaveOidcAuthRequest.mockReset().mockResolvedValue(undefined);
  mockedConsumeOidcAuthRequest.mockReset().mockResolvedValue({ nonce: OIDC_NONCE });
  mockedSupportsPkceS256.mockReset().mockReturnValue(false);
  mockedParseSamlResponse.mockReset().mockResolvedValue({
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
  client_secret: encryptedSsoSecret('secret_xyz'),
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
  client_secret: encryptedSsoSecret('secret_xyz'),
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
  ldap_bind_password: encryptedSsoSecret('admin-secret'),
  ldap_search_base: 'ou=people,dc=corp,dc=com',
  ldap_search_filter: '(uid={{username}})',
  ldap_group_search_base: 'ou=groups,dc=corp,dc=com',
  ldap_group_search_filter: '(member={{dn}})',
  ldap_tls_enabled: false,
  domains: ['corp.com'],
};

function flattenedSqlCalls(): string {
  return JSON.stringify(sqlMock.mock.calls);
}

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
    expect(flattenedSqlCalls()).not.toContain('secret_xyz');
    expect(flattenedSqlCalls()).toContain('vault:v1:');
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
  // State is created lazily because signSsoState depends on initKeys() which runs in beforeAll
  let state: string;
  beforeAll(() => {
    state = signSsoState({
      org: 'dev_TEST', connectionId: 'sso_CONN01', oidcRequestId: OIDC_REQUEST_ID,
    });
  });

  it('rejects signed state after its ten-minute lifetime', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-10T00:00:00Z'));
      const shortLivedState = signSsoState({ org: 'dev_TEST', connectionId: 'sso_CONN01' });
      vi.setSystemTime(new Date('2026-07-10T00:11:00Z'));
      expect(verifySsoState(shortLivedState)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exchanges code, verifies ID token, creates session', async () => {
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]); // SELECT connection

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: 'mock.id.token', access_token: 'at_xxx' }),
      }),
    );
    setSafeFetchForTests(async (url, init, _policy) => fetch(url, init));

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

  it('falls back to signed-state redirect_uri when body omits it', async () => {
    // Common IdP callback flow: only `code` and `state` are POSTed back.
    // The signed state carries the original redirect_uri; we should accept
    // the callback and forward that value to the IdP token endpoint.
    const stateWithRedirect = signSsoState({
      org: 'dev_TEST',
      connectionId: 'sso_CONN01',
      oidcRequestId: OIDC_REQUEST_ID,
      redirectUri: 'https://app.test/callback',
    });
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id_token: 'mock.id.token', access_token: 'at_xxx' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSafeFetchForTests(async (url, init, policy) => fetchMock(url, init, policy));

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state: stateWithRedirect },
    });

    expect(res.statusCode).toBe(200);
    // Confirm the token-exchange call forwarded the signed redirect_uri
    const tokenCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(tokenCall).toBeDefined();
    const body = String(tokenCall![1].body);
    expect(body).toContain('redirect_uri=https%3A%2F%2Fapp.test%2Fcallback');
  });

  it('rejects callback when body redirect_uri mismatches signed state', async () => {
    const stateWithRedirect = signSsoState({
      org: 'dev_TEST',
      connectionId: 'sso_CONN01',
      oidcRequestId: OIDC_REQUEST_ID,
      redirectUri: 'https://app.test/callback',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: {
        code: 'auth_code_xyz',
        state: stateWithRedirect,
        redirect_uri: 'https://attacker.example/steal',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/redirect_uri does not match signed state/);
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
    setSafeFetchForTests(async (url, init, _policy) => fetch(url, init));

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
    setSafeFetchForTests(async (url, init, _policy) => fetch(url, init));

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
  let relayState: string;
  beforeAll(() => { relayState = signSsoState({ org: 'dev_TEST', connectionId: 'sso_CONN02' }); });

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
    mockedParseSamlResponse.mockRejectedValueOnce(
      new Error('SAML Response signature verification failed'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/saml',
      headers: { 'content-type': 'application/json' },
      payload: { SAMLResponse: 'abc', RelayState: relayState },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('SAML response verification failed');
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
    expect(flattenedSqlCalls()).not.toContain('secret_xyz');
    expect(flattenedSqlCalls()).toContain('vault:v1:');
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
    const state = signSsoState({ org: 'dev_TEST', oidcRequestId: OIDC_REQUEST_ID });
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
    setSafeFetchForTests(async (url, init, _policy) => fetch(url, init));

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=auth_code_xyz&state=${state}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('alice@corp.com');
    expect(res.json().developerId).toBe('dev_TEST');
  });

  it('rejects legacy callback when ID token verification fails', async () => {
    const state = signSsoState({ org: 'dev_TEST', oidcRequestId: OIDC_REQUEST_ID });
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);
    mockedVerifyIdToken.mockRejectedValueOnce(new Error('bad signature'));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id_token: 'bad.token.sig', access_token: 'at_xxx' }),
      }),
    );
    setSafeFetchForTests(async (url, init, _policy) => fetch(url, init));

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=auth_code_xyz&state=${state}`,
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('ID token verification failed');
  });

  it('returns 502 when IdP token exchange fails', async () => {
    const state = signSsoState({ org: 'dev_TEST', oidcRequestId: OIDC_REQUEST_ID });
    sqlMock.mockResolvedValueOnce([SSO_CONFIG_ROW]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    setSafeFetchForTests(async (url, init, _policy) => fetch(url, init));

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
    expect(flattenedSqlCalls()).not.toContain('admin-secret');
    expect(flattenedSqlCalls()).toContain('vault:v1:');
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

// ═══════════════════════════════════════════════════════════════════════════
// OIDC nonce + PKCE binding
// ═══════════════════════════════════════════════════════════════════════════

describe('OIDC nonce and PKCE binding', () => {
  function authorizeParams(url: string): URLSearchParams {
    return new URL(url).searchParams;
  }

  it('sends a nonce on every OIDC authorize request', async () => {
    mockedResolveConnection.mockResolvedValueOnce(OIDC_CONNECTION_ROW as never);

    const res = await app.inject({ method: 'GET', url: '/sso/login?org=dev_TEST' });

    expect(res.statusCode).toBe(200);
    const params = authorizeParams(res.json().authorizeUrl);
    expect(params.get('nonce')).toBeTruthy();
    expect(params.get('nonce')!.length).toBeGreaterThanOrEqual(16);
  });

  it('stores the nonce server-side rather than in the state parameter', async () => {
    mockedResolveConnection.mockResolvedValueOnce(OIDC_CONNECTION_ROW as never);
    mockedSaveOidcAuthRequest.mockClear();

    const res = await app.inject({ method: 'GET', url: '/sso/login?org=dev_TEST' });

    const params = authorizeParams(res.json().authorizeUrl);
    const nonce = params.get('nonce')!;
    const state = params.get('state')!;

    // State is signed but not encrypted, so anything inside it is readable by
    // whoever holds the redirect.
    const decodedState = JSON.parse(
      Buffer.from(state.slice(0, state.indexOf('.')), 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    expect(decodedState['oidcRequestId']).toBeTruthy();
    expect(JSON.stringify(decodedState)).not.toContain(nonce);

    expect(mockedSaveOidcAuthRequest).toHaveBeenCalledTimes(1);
    expect(mockedSaveOidcAuthRequest.mock.calls[0]![1]).toMatchObject({ nonce });
  });

  it('omits PKCE when the provider does not advertise S256', async () => {
    mockedResolveConnection.mockResolvedValueOnce(OIDC_CONNECTION_ROW as never);
    mockedSupportsPkceS256.mockReturnValueOnce(false);

    const res = await app.inject({ method: 'GET', url: '/sso/login?org=dev_TEST' });

    const params = authorizeParams(res.json().authorizeUrl);
    expect(params.get('code_challenge')).toBeNull();
    expect(params.get('code_challenge_method')).toBeNull();
  });

  it('sends an S256 challenge when the provider advertises support', async () => {
    mockedResolveConnection.mockResolvedValueOnce(OIDC_CONNECTION_ROW as never);
    mockedSupportsPkceS256.mockReturnValueOnce(true);
    mockedSaveOidcAuthRequest.mockClear();

    const res = await app.inject({ method: 'GET', url: '/sso/login?org=dev_TEST' });

    const params = authorizeParams(res.json().authorizeUrl);
    expect(params.get('code_challenge_method')).toBe('S256');

    // The challenge on the wire must be S256(verifier), and the verifier itself
    // must never appear in the front channel.
    const stored = mockedSaveOidcAuthRequest.mock.calls[0]![1] as { codeVerifier?: string };
    expect(stored.codeVerifier).toBeTruthy();
    const expected = createHash('sha256').update(stored.codeVerifier!).digest('base64url');
    expect(params.get('code_challenge')).toBe(expected);
    expect(res.json().authorizeUrl).not.toContain(stored.codeVerifier!);
  });

  it('sends the code_verifier on the token exchange', async () => {
    const state = signSsoState({
      org: 'dev_TEST', connectionId: 'sso_CONN01', oidcRequestId: 'reqaaaaaaaaaaaaaaaaaaaaa',
    });
    mockedConsumeOidcAuthRequest.mockResolvedValueOnce({
      nonce: 'expected-nonce', codeVerifier: 'the-verifier',
    });
    mockedVerifyIdToken.mockResolvedValueOnce({
      sub: 'idp_user_01', nonce: 'expected-nonce',
    } as never);
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id_token: 'mock.id.token' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    setSafeFetchForTests(async (url, init) => fetch(url, init));

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state },
    });

    expect(res.statusCode).toBe(200);
    const sentBody = String((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(new URLSearchParams(sentBody).get('code_verifier')).toBe('the-verifier');
  });

  it('rejects an ID token whose nonce does not match the request', async () => {
    const state = signSsoState({
      org: 'dev_TEST', connectionId: 'sso_CONN01', oidcRequestId: 'reqbbbbbbbbbbbbbbbbbbbbb',
    });
    mockedConsumeOidcAuthRequest.mockResolvedValueOnce({ nonce: 'expected-nonce' });
    // A token minted for a different login — correctly signed, right issuer and
    // audience, wrong nonce.
    mockedVerifyIdToken.mockResolvedValueOnce({
      sub: 'attacker', nonce: 'other-login',
    } as never);
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id_token: 'mock.id.token' }),
    }));
    setSafeFetchForTests(async (url, init) => fetch(url, init));

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('ID token nonce mismatch');
  });

  it('rejects an ID token carrying no nonce when one was requested', async () => {
    const state = signSsoState({
      org: 'dev_TEST', connectionId: 'sso_CONN01', oidcRequestId: 'reqccccccccccccccccccccc',
    });
    mockedConsumeOidcAuthRequest.mockResolvedValueOnce({ nonce: 'expected-nonce' });
    mockedVerifyIdToken.mockResolvedValueOnce({ sub: 'idp_user_01' } as never);
    sqlMock.mockResolvedValueOnce([OIDC_CONNECTION_ROW]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ id_token: 'mock.id.token' }),
    }));
    setSafeFetchForTests(async (url, init) => fetch(url, init));

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state },
    });

    expect(res.statusCode).toBe(502);
  });

  // The binding must not be optional. If a state lacking a request id were
  // treated as "skip the nonce and PKCE checks", a request field would decide
  // whether a security control runs.
  it('refuses a state that carries no request id at all', async () => {
    const state = signSsoState({ org: 'dev_TEST', connectionId: 'sso_CONN01' });

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state },
    });

    expect(res.statusCode).toBe(400);
    expect(mockedVerifyIdToken).not.toHaveBeenCalled();
  });

  it('refuses a legacy-callback state that carries no request id', async () => {
    const state = signSsoState({ org: 'dev_TEST' });

    const res = await app.inject({
      method: 'GET',
      url: `/sso/callback?code=auth_code_xyz&state=${encodeURIComponent(state)}`,
    });

    expect(res.statusCode).toBe(400);
    expect(mockedVerifyIdToken).not.toHaveBeenCalled();
  });

  it('refuses a state whose stored request was already consumed', async () => {
    const state = signSsoState({
      org: 'dev_TEST', connectionId: 'sso_CONN01', oidcRequestId: 'reqddddddddddddddddddddd',
    });
    // Consume-on-read: a second callback for the same state finds nothing.
    mockedConsumeOidcAuthRequest.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/sso/callback/oidc',
      headers: { 'content-type': 'application/json' },
      payload: { code: 'auth_code_xyz', state },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('expired or already been used');
  });
});
