/**
 * Secrets never exposed in API responses (PRD §13.6)
 *
 * Verifies that API responses and error messages never leak sensitive
 * material such as private keys, raw tokens, database connection strings,
 * or internal stack traces.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildTestApp,
  seedAuth,
  authHeader,
  sqlMock,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// Patterns that should never appear in API responses
const SENSITIVE_PATTERNS = [
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,  // PEM private key
  /-----BEGIN CERTIFICATE-----/,              // X.509 cert
  /sk_live_/,                                 // Stripe live key
  /whsec_/,                                   // Stripe webhook secret
  /postgres:\/\//,                            // Database URL
  /redis:\/\//,                               // Redis URL
  /"d":\s*"/,                                  // RSA private exponent in JWK
  /"dp":\s*"/,                                 // RSA CRT exponent in JWK
  /"dq":\s*"/,                                 // RSA CRT exponent in JWK
  /"qi":\s*"/,                                 // RSA CRT coefficient in JWK
];

function assertNoSecrets(body: string, context: string) {
  for (const pattern of SENSITIVE_PATTERNS) {
    expect(body, `${context}: matched sensitive pattern ${pattern}`).not.toMatch(pattern);
  }
}

describe('Secrets never exposed in API responses', () => {
  // ── JWKS returns public keys only ──────────────────────────────────────

  it('JWKS endpoint returns public keys only — no private key material', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: Array<Record<string, unknown>> }>();

    for (const key of body.keys) {
      // RSA private key components must not be present
      expect(key).not.toHaveProperty('d');
      expect(key).not.toHaveProperty('p');
      expect(key).not.toHaveProperty('q');
      expect(key).not.toHaveProperty('dp');
      expect(key).not.toHaveProperty('dq');
      expect(key).not.toHaveProperty('qi');
      // Ed25519 private key component must not be present
      expect(key).not.toHaveProperty('d');
      // Public components should be present
      if (key['kty'] === 'RSA') {
        expect(key).toHaveProperty('n');
        expect(key).toHaveProperty('e');
      }
      expect(key).toHaveProperty('kid');
    }
  });

  // ── DID document ───────────────────────────────────────────────────────

  it('DID document does not expose private key material', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
    });

    expect(res.statusCode).toBe(200);
    assertNoSecrets(res.body, 'DID document');
  });

  // ── Error responses ────────────────────────────────────────────────────

  it('401 error messages contain no key material', async () => {
    sqlMock.mockResolvedValueOnce([]); // No developer found

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: 'Bearer secret-api-key-leaked-test' },
    });

    expect(res.statusCode).toBe(401);
    assertNoSecrets(res.body, '401 response');
    // Should not echo back the API key
    expect(res.body).not.toContain('secret-api-key-leaked-test');
  });

  it('404 error does not leak internal details', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // Agent not found

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/ag_NONEXISTENT',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    assertNoSecrets(res.body, '404 response');
    // Should not contain SQL query fragments
    expect(res.body).not.toContain('SELECT');
    expect(res.body).not.toContain('FROM agents');
  });

  it('400 error on malformed JSON does not leak stack trace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: {
        ...authHeader(),
        'content-type': 'application/json',
      },
      payload: '{invalid json!!!',
    });

    expect(res.statusCode).toBe(400);
    assertNoSecrets(res.body, '400 malformed JSON');
    // Should not contain file paths or stack traces
    expect(res.body).not.toMatch(/at\s+\w+\s+\(/); // stack trace pattern
    expect(res.body).not.toContain('node_modules');
  });

  // ── Vault credentials ──────────────────────────────────────────────────

  it('vault credential listing does not expose raw access tokens', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'vcred_1',
      principal_id: 'user_123',
      service: 'github',
      credential_type: 'oauth2',
      token_expires_at: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      // Note: access_token and refresh_token are intentionally NOT in the response
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ credentials: Array<Record<string, unknown>> }>();
    for (const cred of body.credentials) {
      // Raw tokens must never appear in listing
      expect(cred).not.toHaveProperty('accessToken');
      expect(cred).not.toHaveProperty('refreshToken');
      expect(cred).not.toHaveProperty('access_token');
      expect(cred).not.toHaveProperty('refresh_token');
    }
  });

  it('vault credential detail does not expose raw access tokens', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      id: 'vcred_1',
      principal_id: 'user_123',
      service: 'github',
      credential_type: 'oauth2',
      token_expires_at: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/vault/credentials/vcred_1',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('refreshToken');
    expect(body).not.toHaveProperty('access_token');
    expect(body).not.toHaveProperty('refresh_token');
  });

  // ── Token verification ──────────────────────────────────────────────────

  it('token verification failure does not expose signing keys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: 'eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0IjoxfQ.invalid' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    assertNoSecrets(res.body, 'credential verify failure');
  });

  // ── Health endpoint ────────────────────────────────────────────────────

  it('health endpoint does not expose connection strings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    // Health check may return 200 or 503 — either way, no secrets
    assertNoSecrets(res.body, 'health endpoint');
    expect(res.body).not.toContain('postgres://');
    expect(res.body).not.toContain('redis://');
  });

  // ── No stack traces in production-style errors ─────────────────────────

  it('unexpected content type returns clean error (no stack trace)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: {
        ...authHeader(),
        'content-type': 'text/xml',
      },
      payload: '<agent><name>test</name></agent>',
    });

    // Fastify returns 415 or 400 for unsupported content type
    expect(res.statusCode).not.toBe(500);
    assertNoSecrets(res.body, 'unsupported content type');
  });
});
