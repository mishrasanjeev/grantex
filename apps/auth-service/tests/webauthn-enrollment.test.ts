import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';
import { generateRegOptions, verifyRegResponse } from '../src/lib/webauthn.js';

let app: FastifyInstance;
const ticketId = `wet_${'0'.repeat(26)}`;
const ticket = `${ticketId}.${'A'.repeat(43)}`;
const expiresAt = new Date(Date.now() + 600_000).toISOString();
const ticketRow = {
  id: ticketId, principal_id: 'person_1', developer_id: 'dev_TEST',
  auth_request_id: 'areq_' + '0'.repeat(26), expires_at: expiresAt,
};
const response = {
  id: 'bW9jay1jcmVkLWlk', rawId: 'bW9jay1jcmVkLWlk', type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'e30' },
  clientExtensionResults: {},
};

beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => vi.unstubAllEnvs());

describe('hosted passkey enrollment', () => {
  it('is disabled by default and never issues a ticket', async () => {
    seedAuth();
    const result = await app.inject({ method: 'POST', url: '/v1/webauthn/enrollment-sessions',
      headers: authHeader(), payload: { principalId: 'person_1' } });
    expect(result.statusCode).toBe(404);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('requires a developer key and validates the principal', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    const noAuth = await app.inject({ method: 'POST', url: '/v1/webauthn/enrollment-sessions',
      payload: { principalId: 'person_1' } });
    expect(noAuth.statusCode).toBe(401);
    seedAuth();
    const badPrincipal = await app.inject({ method: 'POST', url: '/v1/webauthn/enrollment-sessions',
      headers: authHeader(), payload: { principalId: ' person_1 ' } });
    expect(badPrincipal.statusCode).toBe(400);
  });

  it('binds an optional pending authorization request to the tenant and principal', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'POST', url: '/v1/webauthn/enrollment-sessions',
      headers: authHeader(), payload: { principalId: 'person_1', authRequestId: ticketRow.auth_request_id } });
    expect(result.statusCode).toBe(404);
    const query = (sqlMock.mock.calls[1]?.[0] as TemplateStringsArray).join(' ');
    expect(query).toContain('developer_id =');
    expect(query).toContain('principal_id =');
    expect(query).toContain("status = 'pending'");
  });

  it('issues a one-use link on the WebAuthn origin with the secret only in its fragment', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'POST', url: '/v1/webauthn/enrollment-sessions',
      headers: authHeader(), payload: { principalId: 'person_1' } });
    expect(result.statusCode).toBe(201);
    const url = new URL(result.json().enrollmentUrl as string);
    expect(url.origin).toBe('https://grantex.dev');
    expect(url.pathname).toBe('/passkey-enroll');
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#ticket=wet_/);
    expect(result.headers['cache-control']).toBe('no-store');
    const insertQuery = (sqlMock.mock.calls[1]?.[0] as TemplateStringsArray).join(' ');
    expect(insertQuery).toContain('enrollment_ticket');
    expect(sqlMock.mock.calls[1]).not.toContain(new URLSearchParams(url.hash.slice(1)).get('ticket'));
  });

  it('serves a no-store same-origin registration page that removes its ticket fragment', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    const result = await app.inject({ method: 'GET', url: '/passkey-enroll' });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toContain("history.replaceState(null, '', location.pathname)");
    expect(result.body).toContain('navigator.credentials.create');
    expect(result.body).toContain('/v1/webauthn/enroll/verify');
  });

  it('rejects invalid or spent tickets before creating registration options', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    const invalid = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/options', payload: { ticket: 'bad' } });
    expect(invalid.statusCode).toBe(400);
    sqlMock.mockResolvedValueOnce([]);
    const spent = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/options', payload: { ticket } });
    expect(spent.statusCode).toBe(400);
  });

  it('creates a WebAuthn challenge scoped to the ticket, tenant and principal', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([ticketRow]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ name: 'Example App' }]);
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/options', payload: { ticket } });
    expect(result.statusCode).toBe(200);
    expect(result.json().challengeId).toMatch(/^wac_/);
    expect(vi.mocked(generateRegOptions)).toHaveBeenCalledWith('person_1', 'Example App', [], true);
    const insertQuery = (sqlMock.mock.calls[3]?.[0] as TemplateStringsArray).join(' ');
    expect(insertQuery).toContain('enrollment_ticket_id');
  });

  it('fails closed for a mismatched or replayed challenge', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([ticketRow]);
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/verify',
      payload: { ticket, challengeId: 'wac_wrong', response } });
    expect(result.statusCode).toBe(400);
    expect(verifyRegResponse).not.toHaveBeenCalled();
  });

  it('requires user verification and atomically consumes the ticket when storing the credential', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    sqlMock.mockResolvedValueOnce([ticketRow]);
    sqlMock.mockResolvedValueOnce([{ challenge: 'mock-challenge-base64url' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'cred_1' }]);
    const result = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/verify',
      payload: { ticket, challengeId: 'wac_good', response } });
    expect(result.statusCode).toBe(201);
    expect(result.json().returnTo).toBe(`/consent?req=${ticketRow.auth_request_id}`);
    expect(vi.mocked(verifyRegResponse)).toHaveBeenCalledWith(response, 'mock-challenge-base64url', true);
    const insertQuery = (sqlMock.mock.calls[2]?.[0] as TemplateStringsArray).join(' ');
    expect(insertQuery).toContain('WITH claimed AS');
    expect(insertQuery).toContain('consumed = FALSE');
    expect(insertQuery).toContain('INSERT INTO webauthn_credentials');
  });

  it('does not store a credential when attestation fails or the ticket was consumed concurrently', async () => {
    vi.stubEnv('PASSKEY_ENROLLMENT_ENABLED', 'true');
    vi.mocked(verifyRegResponse).mockResolvedValueOnce({ verified: false, registrationInfo: undefined } as never);
    sqlMock.mockResolvedValueOnce([ticketRow]);
    sqlMock.mockResolvedValueOnce([{ challenge: 'mock-challenge-base64url' }]);
    const rejected = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/verify',
      payload: { ticket, challengeId: 'wac_bad', response } });
    expect(rejected.statusCode).toBe(400);
    expect(sqlMock).toHaveBeenCalledTimes(2);

    sqlMock.mockClear();
    sqlMock.mockResolvedValueOnce([ticketRow]);
    sqlMock.mockResolvedValueOnce([{ challenge: 'mock-challenge-base64url' }]);
    sqlMock.mockResolvedValueOnce([]);
    const replayed = await app.inject({ method: 'POST', url: '/v1/webauthn/enroll/verify',
      payload: { ticket, challengeId: 'wac_race', response } });
    expect(replayed.statusCode).toBe(409);
  });
});
