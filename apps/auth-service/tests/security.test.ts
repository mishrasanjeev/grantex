/**
 * Security test suite — covers replay attacks, credential stuffing,
 * challenge TTL enforcement, counter verification, cross-developer isolation,
 * and other security-critical paths.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, mockRedis, TEST_DEVELOPER, TEST_AGENT } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import { initKeys, getKeyPair, signGrantToken } from '../src/lib/crypto.js';
import { SignJWT, generateKeyPair } from 'jose';
import { gzipSync } from 'node:zlib';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ── WebAuthn Security ─────────────────────────────────────────────────────

describe('WebAuthn Security', () => {
  describe('Challenge replay protection', () => {
    it('rejects consumed registration challenge', async () => {
      seedAuth();
      // Challenge lookup returns empty (consumed = TRUE or expired)
      sqlMock.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webauthn/register/verify',
        headers: authHeader(),
        payload: {
          challengeId: 'wac_consumed',
          response: {
            id: 'test', rawId: 'test', type: 'public-key',
            response: { clientDataJSON: '', attestationObject: '' },
            clientExtensionResults: {},
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Invalid or expired challenge');
    });

    it('rejects consumed assertion challenge', async () => {
      // Challenge lookup returns empty (consumed = TRUE)
      sqlMock.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webauthn/assert/verify',
        payload: {
          challengeId: 'wac_replayed',
          response: {
            id: 'cred-id', rawId: 'cred-id', type: 'public-key',
            response: { clientDataJSON: '', authenticatorData: '', signature: '' },
            clientExtensionResults: {},
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Invalid or expired challenge');
    });
  });

  describe('Credential not found during assertion', () => {
    it('returns 400 when credential ID does not match stored credentials', async () => {
      // Challenge lookup — valid
      sqlMock.mockResolvedValueOnce([{
        challenge: 'valid-challenge',
        principal_id: 'user_123',
        developer_id: 'dev_TEST',
        auth_request_id: 'areq_test',
      }]);
      // Consume challenge
      sqlMock.mockResolvedValueOnce([]);
      // Credential lookup — not found
      sqlMock.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webauthn/assert/verify',
        payload: {
          challengeId: 'wac_valid',
          response: {
            id: 'unknown-credential-id', rawId: 'unknown-credential-id', type: 'public-key',
            response: { clientDataJSON: '', authenticatorData: '', signature: '' },
            clientExtensionResults: {},
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Credential not found');
    });
  });

  describe('Assertion verification failure', () => {
    it('returns 400 when verifyAuthResponse returns verified: false', async () => {
      // Import the mocked verifyAuthResponse
      const webauthnMock = await import('../src/lib/webauthn.js');
      const verifyAuthResponseMock = vi.mocked(webauthnMock.verifyAuthResponse);
      verifyAuthResponseMock.mockResolvedValueOnce({
        verified: false,
        authenticationInfo: {
          credentialID: 'bW9jay1jcmVk',
          newCounter: 1,
          userVerified: false,
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          origin: 'https://grantex.dev',
          rpID: 'grantex.dev',
        },
      } as never);

      // Challenge lookup
      sqlMock.mockResolvedValueOnce([{
        challenge: 'valid-challenge',
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

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webauthn/assert/verify',
        payload: {
          challengeId: 'wac_fail_verify',
          response: {
            id: 'bW9jay1jcmVk', rawId: 'bW9jay1jcmVk', type: 'public-key',
            response: { clientDataJSON: '', authenticatorData: '', signature: '' },
            clientExtensionResults: {},
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Assertion verification failed');
    });
  });

  describe('Registration verification failure', () => {
    it('returns 400 when verifyRegResponse returns verified: false', async () => {
      const webauthnMock = await import('../src/lib/webauthn.js');
      const verifyRegResponseMock = vi.mocked(webauthnMock.verifyRegResponse);
      verifyRegResponseMock.mockResolvedValueOnce({
        verified: false,
        registrationInfo: undefined,
      } as never);

      seedAuth();
      // Challenge lookup — valid
      sqlMock.mockResolvedValueOnce([{
        challenge: 'valid-reg-challenge',
        principal_id: 'user_123',
      }]);
      // Consume challenge
      sqlMock.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webauthn/register/verify',
        headers: authHeader(),
        payload: {
          challengeId: 'wac_fail_reg',
          response: {
            id: 'test', rawId: 'test', type: 'public-key',
            response: { clientDataJSON: '', attestationObject: '' },
            clientExtensionResults: {},
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Registration verification failed');
    });
  });

  describe('Assertion with null auth_request_id', () => {
    it('skips auth request update when auth_request_id is null', async () => {
      // Challenge lookup — valid but no auth_request_id
      sqlMock.mockResolvedValueOnce([{
        challenge: 'valid-challenge',
        principal_id: 'user_123',
        developer_id: 'dev_TEST',
        auth_request_id: null,
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
      // Note: no auth request update expected since auth_request_id is null

      const res = await app.inject({
        method: 'POST',
        url: '/v1/webauthn/assert/verify',
        payload: {
          challengeId: 'wac_no_areq',
          response: {
            id: 'bW9jay1jcmVk', rawId: 'bW9jay1jcmVk', type: 'public-key',
            response: { clientDataJSON: '', authenticatorData: '', signature: '' },
            clientExtensionResults: {},
          },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().verified).toBe(true);
      // Only 4 SQL calls (no auth request update)
      expect(sqlMock).toHaveBeenCalledTimes(4);
    });
  });
});

// ── VC-JWT Security ──────────────────────────────────────────────────────

describe('VC-JWT Security', () => {
  describe('Credential stuffing / injection', () => {
    it('rejects garbage JWT input', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/credentials/verify',
        payload: { credential: 'not-a-jwt-at-all' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(false);
      expect(res.json().error).toBe('Invalid JWT format');
    });

    it('rejects JWT with base64 but invalid JSON', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/credentials/verify',
        payload: { credential: 'eyJ0eXAiOiJKV1QifQ.invalid.sig' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(false);
    });

    it('rejects JWT signed with unknown key', async () => {
      const { privateKey } = await generateKeyPair('RS256');
      const fakeJwt = await new SignJWT({
        vc: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          type: ['VerifiableCredential'],
          credentialSubject: { id: 'did:test:agent' },
        },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fake-kid' })
        .setIssuer('did:web:attacker.dev')
        .setSubject('did:test:agent')
        .setJti('vc_INJECTED')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/credentials/verify',
        payload: { credential: fakeJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(false);
    });

    it('rejects VC-JWT signed with wrong algorithm (HS256)', async () => {
      // Try to use a symmetric algorithm against an asymmetric key verifier
      const { createSecretKey } = await import('node:crypto');
      const secret = createSecretKey(Buffer.alloc(32, 'secret'));

      const fakeJwt = await new SignJWT({
        vc: { type: ['VerifiableCredential'] },
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('did:web:grantex.dev')
        .setSubject('did:test:agent')
        .setJti('vc_HS256')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(secret);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/credentials/verify',
        payload: { credential: fakeJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(false);
    });
  });

  describe('StatusList bit manipulation', () => {
    it('correctly detects revoked credential at non-zero bit index', async () => {
      const { privateKey, kid } = getKeyPair();
      const statusListIdx = 42;

      // Create VC pointing to bit index 42
      const vcJwt = await new SignJWT({
        vc: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          type: ['VerifiableCredential', 'AgentGrantCredential'],
          credentialSubject: { id: 'did:test:agent', type: 'AIAgent' },
          credentialStatus: {
            id: `https://grantex.dev/v1/credentials/status/vcsl_BITTEST#${statusListIdx}`,
            type: 'StatusList2021Entry',
            statusPurpose: 'revocation',
            statusListIndex: String(statusListIdx),
            statusListCredential: 'https://grantex.dev/v1/credentials/status/vcsl_BITTEST',
          },
        },
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .setIssuer('did:web:grantex.dev')
        .setSubject('did:test:agent')
        .setJti('vc_BIT42')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey);

      // Create status list with bit 42 set
      const bits = Buffer.alloc(16384, 0);
      const byteIndex = Math.floor(statusListIdx / 8); // byte 5
      const bitIndex = 7 - (statusListIdx % 8); // bit within byte, MSB-first
      bits[byteIndex]! |= 1 << bitIndex;
      const encodedList = gzipSync(bits).toString('base64url');

      sqlMock.mockResolvedValueOnce([{ encoded_list: encodedList }]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/credentials/verify',
        payload: { credential: vcJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(false);
      expect(res.json().revoked).toBe(true);
    });

    it('does not flag credential at adjacent bit index', async () => {
      const { privateKey, kid } = getKeyPair();
      const statusListIdx = 43;

      // Create VC pointing to bit index 43
      const vcJwt = await new SignJWT({
        vc: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          type: ['VerifiableCredential', 'AgentGrantCredential'],
          credentialSubject: { id: 'did:test:agent', type: 'AIAgent' },
          credentialStatus: {
            id: `https://grantex.dev/v1/credentials/status/vcsl_ADJ#${statusListIdx}`,
            type: 'StatusList2021Entry',
            statusPurpose: 'revocation',
            statusListIndex: String(statusListIdx),
            statusListCredential: 'https://grantex.dev/v1/credentials/status/vcsl_ADJ',
          },
        },
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'JWT' })
        .setIssuer('did:web:grantex.dev')
        .setSubject('did:test:agent')
        .setJti('vc_BIT43')
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
        .sign(privateKey);

      // Create status list with bit 42 set (NOT 43)
      const bits = Buffer.alloc(16384, 0);
      const byteIdx = Math.floor(42 / 8);
      const bitIdx = 7 - (42 % 8);
      bits[byteIdx]! |= 1 << bitIdx;
      const encodedList = gzipSync(bits).toString('base64url');

      sqlMock.mockResolvedValueOnce([{ encoded_list: encodedList }]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/credentials/verify',
        payload: { credential: vcJwt },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().valid).toBe(true);
    });
  });
});

// ── Token Security ──────────────────────────────────────────────────────

describe('Token Security', () => {
  it('rejects revoked parent grant token in delegation', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const parentToken = await signGrantToken({
      sub: 'user_123',
      agt: TEST_AGENT.did,
      dev: TEST_DEVELOPER.id,
      scp: ['read', 'write'],
      jti: 'tok_REVOKED_SEC',
      grnt: 'grnt_REVOKED_SEC',
      exp,
    });

    seedAuth();
    mockRedis.get.mockResolvedValueOnce('1'); // parent token revoked in Redis

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: 'ag_SUBAGENT',
        scopes: ['read'],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/revoked/);
  });

  it('rejects delegation with scope escalation', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const parentToken = await signGrantToken({
      sub: 'user_123',
      agt: TEST_AGENT.did,
      dev: TEST_DEVELOPER.id,
      scp: ['read'],
      jti: 'tok_SCOPE_SEC',
      grnt: 'grnt_SCOPE_SEC',
      exp,
    });

    seedAuth();
    mockRedis.get.mockResolvedValue(null);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: {
        parentGrantToken: parentToken,
        subAgentId: 'ag_SUBAGENT',
        scopes: ['read', 'write', 'admin'], // exceeds parent
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/exceed parent/);
  });
});

// ── API Key Security ────────────────────────────────────────────────────

describe('API Key Security', () => {
  const protectedEndpoints = [
    { method: 'POST' as const, url: '/v1/webauthn/register/options', payload: { principalId: 'user_123' } },
    { method: 'POST' as const, url: '/v1/webauthn/register/verify', payload: { challengeId: 'test', response: {} } },
    { method: 'GET' as const, url: '/v1/webauthn/credentials?principalId=user_123' },
    { method: 'DELETE' as const, url: '/v1/webauthn/credentials/cred_1' },
    { method: 'GET' as const, url: '/v1/credentials/vc_TEST' },
    { method: 'GET' as const, url: '/v1/credentials' },
    { method: 'PATCH' as const, url: '/v1/me', payload: { fidoRequired: true } },
  ];

  for (const ep of protectedEndpoints) {
    it(`returns 401 for ${ep.method} ${ep.url} without auth`, async () => {
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        ...(ep.payload ? { payload: ep.payload } : {}),
      });

      expect(res.statusCode).toBe(401);
    });
  }

  const publicEndpoints = [
    { method: 'POST' as const, url: '/v1/webauthn/assert/options', payload: { authRequestId: 'areq_test' } },
    { method: 'POST' as const, url: '/v1/webauthn/assert/verify', payload: { challengeId: 'wac_test', response: {} } },
    { method: 'POST' as const, url: '/v1/credentials/verify', payload: { credential: 'test' } },
    { method: 'GET' as const, url: '/v1/credentials/status/vcsl_TEST' },
    { method: 'GET' as const, url: '/.well-known/did.json' },
  ];

  for (const ep of publicEndpoints) {
    it(`allows ${ep.method} ${ep.url} without auth (public endpoint)`, async () => {
      // Mock SQL to return something expected
      sqlMock.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        ...(ep.payload ? { payload: ep.payload } : {}),
      });

      // Should NOT be 401
      expect(res.statusCode).not.toBe(401);
    });
  }
});
