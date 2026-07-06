import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

const FUTURE = new Date(Date.now() + 86400_000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

const TEST_CONSENT_ROW = {
  id: 'areq_TEST01',
  scopes: ['calendar:read', 'payments:initiate:max_500'],
  expires_at: FUTURE,
  status: 'pending',
  redirect_uri: 'https://example.com/callback',
  state: 'xyz',
  agent_name: 'Travel Booker Agent',
  agent_description: 'Books flights and hotels for you',
  agent_did: 'did:grantex:ag_TEST01AGENTID',
};

describe('GET /consent', () => {
  it('returns 200 HTML page regardless of req param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/consent?req=areq_TEST01',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Authorization Request');
  });

  it('does not require API key auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/consent' });
    expect(res.statusCode).toBe(200);
  });

  it('includes client-side escaping helpers for developer-controlled content', async () => {
    const res = await app.inject({ method: 'GET', url: '/consent' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('function esc(value)');
    expect(res.body).toContain("replace(/</g, '&lt;')");
  });

  it('includes hosted passkey approval wiring for live consent requests', async () => {
    const res = await app.inject({ method: 'GET', url: '/consent?req=areq_TEST01' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/v1/webauthn/assert/options');
    expect(res.body).toContain('/v1/webauthn/assert/verify');
    expect(res.body).toContain('navigator.credentials.get');
    expect(res.body).toContain('PRINCIPAL_VERIFICATION_REQUIRED');
  });
});

describe('GET /v1/consent/:id', () => {
  it('returns request details with scope descriptions', async () => {
    sqlMock.mockResolvedValueOnce([TEST_CONSENT_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent/areq_TEST01',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      id: string;
      agentName: string;
      agentDid: string;
      agentDescription: string;
      scopes: string[];
      scopeDescriptions: string[];
      expiresAt: string;
      status: string;
    }>();
    expect(body.id).toBe('areq_TEST01');
    expect(body.agentName).toBe('Travel Booker Agent');
    expect(body.agentDid).toBe('did:grantex:ag_TEST01AGENTID');
    expect(body.agentDescription).toBe('Books flights and hotels for you');
    expect(body.scopes).toEqual(['calendar:read', 'payments:initiate:max_500']);
    expect(body.scopeDescriptions[0]).toBe('Read your calendar events');
    expect(body.scopeDescriptions[1]).toBe('Initiate payments up to 500 in your account\'s base currency');
    expect(body.status).toBe('pending');
  });

  it('returns 404 when not found', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent/nonexistent',
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 410 when expired', async () => {
    sqlMock.mockResolvedValueOnce([{ ...TEST_CONSENT_ROW, expires_at: PAST }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent/areq_TEST01',
    });

    expect(res.statusCode).toBe(410);
  });

  it('returns 410 when already processed', async () => {
    sqlMock.mockResolvedValueOnce([{ ...TEST_CONSENT_ROW, status: 'approved' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent/areq_TEST01',
    });

    expect(res.statusCode).toBe(410);
  });

  it('does not require API key auth', async () => {
    sqlMock.mockResolvedValueOnce([TEST_CONSENT_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/consent/areq_TEST01',
      // No authorization header
    });

    expect(res.statusCode).toBe(200);
  });
});

describe('POST /v1/consent/:id/approve', () => {
  it('returns code and redirect info on sandbox or principal-verified success', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      code: 'AUTHCODE123',
      redirect_uri: 'https://example.com/callback',
      state: 'xyz',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ code: string; redirectUri: string; state: string }>();
    expect(body.code).toBe('AUTHCODE123');
    expect(body.redirectUri).toBe('https://example.com/callback');
    expect(body.state).toBe('xyz');
  });

  it('omits redirectUri/state when null', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      code: 'AUTHCODE456',
      redirect_uri: null,
      state: null,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body['code']).toBe('AUTHCODE456');
    expect(body['redirectUri']).toBeUndefined();
    expect(body['state']).toBeUndefined();
  });

  it('returns 410 when expired or already processed', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
    });

    expect(res.statusCode).toBe(410);
  });

  it('does not require API key auth', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      code: 'AUTHCODE789',
      redirect_uri: null,
      state: null,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
      // No authorization header
    });

    expect(res.statusCode).toBe(200);
  });

  it('blocks live approval without principal verification', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{
      fido_required: false,
      mode: 'live',
      fido_verified: false,
      status: 'pending',
      expires_at: FUTURE,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('PRINCIPAL_VERIFICATION_REQUIRED');
  });

  it('approves a live request after WebAuthn assertion verification', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{
      fido_required: false,
      mode: 'live',
      fido_verified: false,
      status: 'pending',
      expires_at: FUTURE,
    }]);

    const firstApprove = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
    });
    expect(firstApprove.statusCode).toBe(403);
    expect(firstApprove.json<{ code: string }>().code).toBe('PRINCIPAL_VERIFICATION_REQUIRED');

    sqlMock.mockResolvedValueOnce([{
      principal_id: 'user_123',
      developer_id: 'dev_TEST',
      fido_required: false,
      mode: 'live',
    }]);
    sqlMock.mockResolvedValueOnce([{
      credential_id: 'bW9jay1jcmVkLWlk',
      public_key: 'AQIDBA',
      counter: 5,
      transports: ['internal'],
    }]);
    sqlMock.mockResolvedValueOnce([]);

    const options = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/options',
      payload: { authRequestId: 'areq_TEST01' },
    });
    expect(options.statusCode).toBe(200);
    const optionsBody = options.json<{ challengeId: string }>();
    expect(optionsBody.challengeId).toBeDefined();

    sqlMock.mockResolvedValueOnce([{
      challenge: 'mock-auth-challenge-base64url',
      principal_id: 'user_123',
      developer_id: 'dev_TEST',
      auth_request_id: 'areq_TEST01',
    }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{
      id: 'cred_DB',
      credential_id: 'bW9jay1jcmVkLWlk',
      public_key: 'AQIDBA',
      counter: 5,
      transports: ['internal'],
    }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const verify = await app.inject({
      method: 'POST',
      url: '/v1/webauthn/assert/verify',
      payload: {
        challengeId: optionsBody.challengeId,
        response: {
          id: 'bW9jay1jcmVkLWlk',
          rawId: 'bW9jay1jcmVkLWlk',
          type: 'public-key',
          response: {
            clientDataJSON: 'Y2xpZW50',
            authenticatorData: 'YXV0aA',
            signature: 'c2ln',
          },
        },
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json<{ verified: boolean }>().verified).toBe(true);

    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      code: 'AUTHCODE_VERIFIED',
      redirect_uri: 'https://example.com/callback',
      state: 'xyz',
    }]);

    const secondApprove = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/approve',
    });
    expect(secondApprove.statusCode).toBe(200);
    expect(secondApprove.json<{ code: string }>().code).toBe('AUTHCODE_VERIFIED');
  });
});

describe('POST /v1/consent/:id/deny', () => {
  it('returns redirectUri and state on success', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      redirect_uri: 'https://example.com/callback',
      state: 'xyz',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/deny',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ redirectUri: string; state: string }>();
    expect(body.redirectUri).toBe('https://example.com/callback');
    expect(body.state).toBe('xyz');
  });

  it('returns 404 when not found or already processed', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/nonexistent/deny',
    });

    expect(res.statusCode).toBe(404);
  });

  it('does not require API key auth', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'areq_TEST01',
      redirect_uri: null,
      state: null,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/deny',
      // No authorization header
    });

    expect(res.statusCode).toBe(200);
  });

  it('blocks live denial without principal verification', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{
      mode: 'live',
      fido_verified: false,
      status: 'pending',
      expires_at: FUTURE,
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent/areq_TEST01/deny',
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('PRINCIPAL_VERIFICATION_REQUIRED');
  });
});
