import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ---------------------------------------------------------------
// POST /v1/webauthn/register/options
// ---------------------------------------------------------------
describe('POST /v1/webauthn/register/options', () => {
  it('returns 400 when principalId is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/options',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns registration options and challengeId', async () => {
    seedAuth();
    // Existing credentials query
    sqlMock.mockResolvedValueOnce([]);
    // Insert challenge
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/options',
      headers: authHeader(),
      payload: { principalId: 'user_123' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challengeId).toBeDefined();
    expect(body.publicKey).toBeDefined();
    expect(body.publicKey.challenge).toBeDefined();
  });

  it('requires auth (returns 401 without API key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/options',
      payload: { principalId: 'user_123' },
    });

    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------
// POST /v1/webauthn/register/verify
// ---------------------------------------------------------------
describe('POST /v1/webauthn/register/verify', () => {
  it('returns 400 when challengeId is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/verify',
      headers: authHeader(),
      payload: { response: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 400 when response is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/verify',
      headers: authHeader(),
      payload: { challengeId: 'wac_test' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 400 for invalid/expired challenge', async () => {
    seedAuth();
    // Challenge lookup returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/verify',
      headers: authHeader(),
      payload: {
        challengeId: 'wac_nonexistent',
        response: { id: 'test', rawId: 'test', type: 'public-key', response: { clientDataJSON: '', attestationObject: '' }, clientExtensionResults: {} },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Invalid or expired challenge');
  });

  it('creates credential on successful registration', async () => {
    seedAuth();
    // Challenge lookup
    sqlMock.mockResolvedValueOnce([{ challenge: 'mock-challenge', principal_id: 'user_123' }]);
    // Consume challenge
    sqlMock.mockResolvedValueOnce([]);
    // Insert credential
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/register/verify',
      headers: authHeader(),
      payload: {
        challengeId: 'wac_test',
        response: { id: 'test', rawId: 'test', type: 'public-key', response: { clientDataJSON: '', attestationObject: '' }, clientExtensionResults: {} },
        deviceName: 'My YubiKey',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^cred_/);
    expect(body.principalId).toBe('user_123');
    expect(body.deviceName).toBe('My YubiKey');
    expect(body.backedUp).toBe(true);
  });
});

// ---------------------------------------------------------------
// GET /v1/webauthn/credentials
// ---------------------------------------------------------------
describe('GET /v1/webauthn/credentials', () => {
  it('returns 400 when principalId is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webauthn/credentials',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns empty credentials list', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webauthn/credentials?principalId=user_123',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toEqual([]);
  });

  it('returns credentials for a principal', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'cred_1',
        principal_id: 'user_123',
        device_name: 'My YubiKey',
        backed_up: true,
        transports: ['usb'],
        created_at: '2026-03-08T00:00:00Z',
        last_used_at: null,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/webauthn/credentials?principalId=user_123',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const creds = res.json().credentials;
    expect(creds).toHaveLength(1);
    expect(creds[0].id).toBe('cred_1');
    expect(creds[0].deviceName).toBe('My YubiKey');
    expect(creds[0].backedUp).toBe(true);
    expect(creds[0].transports).toEqual(['usb']);
  });
});

// ---------------------------------------------------------------
// DELETE /v1/webauthn/credentials/:id
// ---------------------------------------------------------------
describe('DELETE /v1/webauthn/credentials/:id', () => {
  it('deletes a credential', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'cred_1' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/webauthn/credentials/cred_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown credential', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/webauthn/credentials/cred_nonexistent',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------
// POST /v1/webauthn/assert/options (public)
// ---------------------------------------------------------------
describe('POST /v1/webauthn/assert/options', () => {
  it('returns 400 when authRequestId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('returns 404 for unknown auth request', async () => {
    // Auth request lookup
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: { authRequestId: 'areq_nonexistent' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when FIDO not required for developer', async () => {
    // Auth request lookup — fido_required is false
    sqlMock.mockResolvedValueOnce([{
      principal_id: 'user_123',
      developer_id: 'dev_TEST',
      fido_required: false,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: { authRequestId: 'areq_test' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('FIDO not required');
  });

  it('returns 400 when principal has no FIDO credentials', async () => {
    // Auth request lookup — fido_required is true
    sqlMock.mockResolvedValueOnce([{
      principal_id: 'user_123',
      developer_id: 'dev_TEST',
      fido_required: true,
    }]);
    // Credentials lookup — empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: { authRequestId: 'areq_test' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('No FIDO credentials');
  });

  it('returns assertion options when FIDO is required and credentials exist', async () => {
    // Auth request lookup
    sqlMock.mockResolvedValueOnce([{
      principal_id: 'user_123',
      developer_id: 'dev_TEST',
      fido_required: true,
    }]);
    // Credentials lookup
    sqlMock.mockResolvedValueOnce([{
      credential_id: 'bW9jay1jcmVk',
      public_key: 'AQIDBA',
      counter: 5,
      transports: ['internal'],
    }]);
    // Insert challenge
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: { authRequestId: 'areq_test' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.challengeId).toBeDefined();
    expect(body.publicKey).toBeDefined();
    expect(body.publicKey.challenge).toBeDefined();
  });

  it('does not require auth (public endpoint)', async () => {
    // Auth request lookup — no match
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: { authRequestId: 'areq_test' },
    });

    // Should get 404 (not found), not 401 (unauthorized)
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------
// POST /v1/webauthn/assert/verify (public)
// ---------------------------------------------------------------
describe('POST /v1/webauthn/assert/verify', () => {
  it('returns 400 when challengeId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/verify',
      payload: { response: {} },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid/expired challenge', async () => {
    // Challenge lookup — empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/verify',
      payload: {
        challengeId: 'wac_expired',
        response: { id: 'cred-id', rawId: 'cred-id', type: 'public-key', response: { clientDataJSON: '', authenticatorData: '', signature: '' }, clientExtensionResults: {} },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('Invalid or expired challenge');
  });

  it('returns verified: true on successful assertion', async () => {
    // Challenge lookup
    sqlMock.mockResolvedValueOnce([{
      challenge: 'mock-auth-challenge',
      principal_id: 'user_123',
      developer_id: 'dev_TEST',
      auth_request_id: 'areq_test',
    }]);
    // Consume challenge
    sqlMock.mockResolvedValueOnce([]);
    // Credential lookup
    sqlMock.mockResolvedValueOnce([{
      id: 'cred_1',
      credential_id: 'bW9jay1jcmVk',
      public_key: 'AQIDBA',
      counter: 5,
      transports: ['internal'],
    }]);
    // Update counter
    sqlMock.mockResolvedValueOnce([]);
    // Update auth request fido_verified
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/verify',
      payload: {
        challengeId: 'wac_test',
        response: { id: 'bW9jay1jcmVk', rawId: 'bW9jay1jcmVk', type: 'public-key', response: { clientDataJSON: '', authenticatorData: '', signature: '' }, clientExtensionResults: {} },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().verified).toBe(true);
  });
});

// ---------------------------------------------------------------
// PATCH /v1/me (FIDO settings)
// ---------------------------------------------------------------
describe('PATCH /v1/me', () => {
  it('returns 400 when no fields provided', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('updates fidoRequired', async () => {
    seedAuth();
    // Update query
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: authHeader(),
      payload: { fidoRequired: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
  });

  it('updates fidoRpName', async () => {
    seedAuth();
    // Update query
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: authHeader(),
      payload: { fidoRpName: 'My App' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
  });

  it('updates both fields at once', async () => {
    seedAuth();
    // Update query
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: authHeader(),
      payload: { fidoRequired: true, fidoRpName: 'My App' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
  });

  it('requires auth', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      payload: { fidoRequired: true },
    });

    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------
// Consent FIDO enforcement
// ---------------------------------------------------------------
describe('POST /v1/consent/:id/approve (FIDO enforcement)', () => {
  it('returns 403 when FIDO required but not verified', async () => {
    // UPDATE returns no rows (FIDO gate blocks it)
    sqlMock.mockResolvedValueOnce([]);
    // Follow-up FIDO check query
    sqlMock.mockResolvedValueOnce([{
      fido_required: true,
      fido_verified: false,
      status: 'pending',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_test/approve',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FIDO_REQUIRED');
  });

  it('allows approval when FIDO not required', async () => {
    // UPDATE succeeds (FIDO not required, so WHERE clause passes)
    sqlMock.mockResolvedValueOnce([{ id: 'areq_test', code: 'TESTCODE', redirect_uri: null, state: null }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_test/approve',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBeDefined();
  });

  it('allows approval when FIDO required and verified', async () => {
    // UPDATE succeeds (fido_verified=TRUE satisfies the WHERE clause)
    sqlMock.mockResolvedValueOnce([{ id: 'areq_test', code: 'TESTCODE', redirect_uri: null, state: null }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_test/approve',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBeDefined();
  });
});
