/**
 * Cryptographic correctness tests (PRD §13.7)
 *
 * Verifies that the system uses strong cryptographic primitives:
 * RSA key sizes, algorithm enforcement, JWKS structure, key rotation
 * semantics, and grant token signature verification.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  buildTestApp,
  seedAuth,
  authHeader,
} from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { getKeyPair, signGrantToken } from '../src/lib/crypto.js';
import { generateKeyPair, SignJWT } from 'jose';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

describe('Cryptographic correctness', () => {
  // ── RSA key size ────────────────────────────────────────────────────────

  it('RSA key is at least 2048 bits', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ keys: Array<Record<string, unknown>> }>();
    const rsaKey = body.keys.find((k) => k['kty'] === 'RSA');
    expect(rsaKey).toBeDefined();

    // The modulus 'n' in base64url — length indicates key size
    // 2048-bit RSA modulus = 256 bytes = ~342 base64url chars
    const modulusLength = Buffer.from(rsaKey!['n'] as string, 'base64url').length;
    expect(modulusLength).toBeGreaterThanOrEqual(256); // >= 2048 bits
  });

  // ── Algorithm enforcement ───────────────────────────────────────────────

  it('JWKS keys specify correct algorithms', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    const body = res.json<{ keys: Array<Record<string, unknown>> }>();
    for (const key of body.keys) {
      // Only RS256 and EdDSA are allowed
      expect(['RS256', 'EdDSA']).toContain(key['alg']);
      expect(key['use']).toBe('sig');
    }
  });

  it('grant tokens use RS256 algorithm', async () => {
    const token = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_01',
      dev: 'dev_TEST',
      scp: ['read'],
      jti: 'tok_ALG_CHECK',
      grnt: 'grnt_ALG_CHECK',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Decode the header to check algorithm
    const [headerB64] = token.split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString());
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBeDefined();
  });

  // ── Token signed with wrong key is rejected ────────────────────────────

  it('token signed with different RSA key is rejected by /v1/tokens/verify', async () => {
    // Generate a different RSA key pair
    const { privateKey: foreignKey } = await generateKeyPair('RS256');

    const fakeToken = await new SignJWT({
      agt: 'did:grantex:ag_FAKE',
      dev: 'dev_TEST',
      scp: ['read'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-kid' })
      .setIssuer('https://grantex.dev')
      .setSubject('user_123')
      .setJti('tok_WRONG_KEY')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(foreignKey);

    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: fakeToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  it('token signed with HS256 (symmetric) is rejected', async () => {
    const { createSecretKey } = await import('node:crypto');
    const secret = createSecretKey(Buffer.alloc(32, 'test-secret'));

    const symToken = await new SignJWT({
      agt: 'did:grantex:ag_SYM',
      dev: 'dev_TEST',
      scp: ['read'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://grantex.dev')
      .setSubject('user_123')
      .setJti('tok_SYM')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secret);

    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: symToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  // ── JWKS kid matches tokens ────────────────────────────────────────────

  it('JWKS kid matches the kid used in grant tokens', async () => {
    const { kid } = getKeyPair();

    const jwksRes = await app.inject({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });

    const jwksBody = jwksRes.json<{ keys: Array<Record<string, unknown>> }>();
    const kids = jwksBody.keys.map((k) => k['kid']);
    expect(kids).toContain(kid);
  });

  // ── Expired tokens ────────────────────────────────────────────────────

  it('expired grant token is rejected by verify endpoint', async () => {
    const expiredToken = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_01',
      dev: 'dev_TEST',
      scp: ['read'],
      jti: 'tok_EXPIRED',
      grnt: 'grnt_EXPIRED',
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
    });

    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: expiredToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  // ── Token with tampered payload ──────────────────────────────────────

  it('tampered token payload is rejected', async () => {
    const validToken = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_01',
      dev: 'dev_TEST',
      scp: ['read'],
      jti: 'tok_TAMPER',
      grnt: 'grnt_TAMPER',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    // Tamper with the payload portion
    const parts = validToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    payload.scp = ['read', 'write', 'admin']; // escalate scopes
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tamperedToken = parts.join('.');

    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/tokens/verify',
      headers: authHeader(),
      payload: { token: tamperedToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  // ── VC-JWT algorithm verification ──────────────────────────────────────

  it('VC-JWT signed with wrong issuer key is rejected', async () => {
    const { privateKey: foreignKey } = await generateKeyPair('RS256');

    const fakeVc = await new SignJWT({
      vc: {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        type: ['VerifiableCredential'],
        credentialSubject: { id: 'did:test:agent' },
      },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'foreign-kid' })
      .setIssuer('did:web:attacker.com')
      .setSubject('did:test:agent')
      .setJti('vc_FOREIGN')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(foreignKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/credentials/verify',
      payload: { credential: fakeVc },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });
});
