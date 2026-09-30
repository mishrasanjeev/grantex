import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import { createSsoSession, findSsoSession, hashSsoToken } from '../src/lib/sso.js';

let app: FastifyInstance;
const token = `gx_sso_${'a'.repeat(43)}`;
const future = new Date(Date.now() + 3_600_000).toISOString();
const session = {
  id: 'ssosess_TEST', developer_id: 'dev_TEST', connection_id: 'sso_TEST',
  principal_id: 'scimuser_TEST', email: 'user@example.test', name: 'Test User',
  idp_subject: 'subject-test', groups: ['admins'], mapped_scopes: ['admin'],
  expires_at: future, created_at: new Date().toISOString(),
};

beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('SSO session credentials', () => {
  it('rejects an audit ID and malformed bearer tokens', () => {
    expect(hashSsoToken('ssosess_TEST')).toBeNull();
    expect(hashSsoToken('gx_sso_short')).toBeNull();
    expect(hashSsoToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('issues a random credential and stores only its hash when enabled', async () => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([session]);
    const issued = await createSsoSession({
      developerId: 'dev_TEST', connectionId: 'sso_TEST', principalId: 'scimuser_TEST',
      idpSubject: 'subject-test', groups: [], mappedScopes: ['admin'],
    });
    expect(issued.token).toMatch(/^gx_sso_[A-Za-z0-9_-]{43}$/);
    const call = sqlMock.mock.calls.at(-1)!;
    expect(call).toContain(hashSsoToken(issued.token!));
    expect(call).not.toContain(issued.token);
  });

  it('rejects a revoked or expired session and accepts an active one', async () => {
    sqlMock.mockResolvedValueOnce([]);
    expect(await findSsoSession(token)).toBeNull();
    sqlMock.mockResolvedValueOnce([session]);
    expect((await findSsoSession(token))?.principal_id).toBe('scimuser_TEST');
    expect(sqlMock.mock.calls.at(-1)!.join(' ')).toContain('expires_at > NOW()');
  });
});

describe('human SSO authorization', () => {
  it('accepts an admin-scoped active SSO session for the dashboard API', async () => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([session]);
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'dev_TEST', name: 'Test Developer', email: null, mode: 'live', plan: 'free',
      fido_required: true, fido_rp_name: null, sso_enforced: true, created_at: future,
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ssoEnforced: true, humanSession: true });
  });

  it('does not grant dashboard access to a non-admin principal session', async () => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([{ ...session, mapped_scopes: ['read'] }]);
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('keeps machine API-key access distinct from human dashboard sign-in', async () => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'dev_TEST', name: 'Test Developer', email: null, mode: 'live', plan: 'free',
      fido_required: true, fido_rp_name: null, sso_enforced: true, created_at: future,
    }]);
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ssoEnforced: true, humanSession: false });
  });
});

describe('consent binds SSO identity to the requested principal', () => {
  const pending = { status: 'pending', expires_at: future, mode: 'live', fido_required: true, fido_verified: true, sso_enforced: true };

  it.each(['approve', 'deny'])('rejects %s with no matching SSO session', async (action) => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ ...pending, sso_valid: false }]);
    const res = await app.inject({ method: 'POST', url: `/v1/consent/request_TEST/${action}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SSO_REQUIRED');
    expect(sqlMock.mock.calls.at(-2)!.join(' ')).toContain('ss.principal_id = auth_requests.principal_id');
  });

  it('still requires passkey proof after a matching SSO session', async () => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ ...pending, fido_verified: false, sso_valid: true }]);
    const res = await app.inject({ method: 'POST', url: '/v1/consent/request_TEST/approve', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('PRINCIPAL_VERIFICATION_REQUIRED');
  });

  it('allows an atomic approval with a matching session and passkey proof', async () => {
    vi.stubEnv('SSO_HUMAN_ENFORCEMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([{ id: 'request_TEST', code: 'code_TEST', redirect_uri: null, state: null, protocol: 'legacy' }]);
    const res = await app.inject({ method: 'POST', url: '/v1/consent/request_TEST/approve', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe('code_TEST');
    expect(sqlMock.mock.calls.at(-1)!).toContain(hashSsoToken(token));
  });
});
