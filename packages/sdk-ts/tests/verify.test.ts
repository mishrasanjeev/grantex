import { describe, it, expect, vi, afterEach } from 'vitest';
import { GrantexTokenError } from '../src/errors.js';

// Mock jose before importing verify
vi.mock('jose', () => {
  const mockJwtVerify = vi.fn();
  const mockDecodeJwt = vi.fn();
  const mockCreateRemoteJWKSet = vi.fn(() => 'mock-jwks');
  return {
    jwtVerify: mockJwtVerify,
    decodeJwt: mockDecodeJwt,
    createRemoteJWKSet: mockCreateRemoteJWKSet,
  };
});

// Import after mock is in place
const { verifyGrantToken } = await import('../src/verify.js');
const { mapOnlineVerifyToVerifiedGrant } = await import('../src/verify.js');
import * as jose from 'jose';

const VALID_PAYLOAD = {
  iss: 'https://grantex.dev',
  sub: 'user_abc123',
  agt: 'did:grantex:ag_01HXYZ123abc',
  dev: 'org_test',
  scp: ['calendar:read', 'payments:initiate:max_500'],
  iat: 1700000000,
  exp: 1700086400,
  jti: 'tok_01HXYZ987xyz',
  grnt: 'grant_01',
};

describe('verifyGrantToken', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns VerifiedGrant for a valid token', async () => {
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await verifyGrantToken('fake.token.here', {
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
    });

    expect(result.tokenId).toBe('tok_01HXYZ987xyz');
    expect(result.grantId).toBe('grant_01');
    expect(result.principalId).toBe('user_abc123');
    expect(result.agentDid).toBe('did:grantex:ag_01HXYZ123abc');
    expect(result.developerId).toBe('org_test');
    expect(result.scopes).toEqual(['calendar:read', 'payments:initiate:max_500']);
    expect(result.issuedAt).toBe(1700000000);
    expect(result.expiresAt).toBe(1700086400);
  });

  it('throws GrantexTokenError when jose throws', async () => {
    vi.mocked(jose.jwtVerify).mockRejectedValue(
      new Error('JWTExpired: token has expired'),
    );

    await expect(
      verifyGrantToken('expired.token', {
        jwksUri: 'https://grantex.dev/.well-known/jwks.json',
      }),
    ).rejects.toBeInstanceOf(GrantexTokenError);
  });

  it('throws GrantexTokenError when required scopes are missing', async () => {
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: 'RS256' },
    } as never);

    await expect(
      verifyGrantToken('fake.token.here', {
        jwksUri: 'https://grantex.dev/.well-known/jwks.json',
        requiredScopes: ['payments:initiate', 'missing:scope'],
      }),
    ).rejects.toThrow(/missing required scopes/);
  });

  it('passes when required scopes are a subset of token scopes', async () => {
    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: VALID_PAYLOAD,
      protectedHeader: { alg: 'RS256' },
    } as never);

    await expect(
      verifyGrantToken('fake.token.here', {
        jwksUri: 'https://grantex.dev/.well-known/jwks.json',
        requiredScopes: ['calendar:read'],
      }),
    ).resolves.toBeDefined();
  });

  it('falls back to jti for grantId when grnt claim is absent', async () => {
    const payloadNoGrnt = { ...VALID_PAYLOAD };
    delete (payloadNoGrnt as Partial<typeof VALID_PAYLOAD>).grnt;

    vi.mocked(jose.jwtVerify).mockResolvedValue({
      payload: payloadNoGrnt,
      protectedHeader: { alg: 'RS256' },
    } as never);

    const result = await verifyGrantToken('fake.token.here', {
      jwksUri: 'https://grantex.dev/.well-known/jwks.json',
    });

    expect(result.grantId).toBe('tok_01HXYZ987xyz');
  });
});

describe('mapOnlineVerifyToVerifiedGrant', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('decodes token without verification', () => {
    vi.mocked(jose.decodeJwt).mockReturnValue(VALID_PAYLOAD as never);

    const result = mapOnlineVerifyToVerifiedGrant('any.token');
    expect(result.principalId).toBe('user_abc123');
    expect(result.scopes).toEqual(['calendar:read', 'payments:initiate:max_500']);
  });

  it('throws GrantexTokenError when decodeJwt throws', () => {
    vi.mocked(jose.decodeJwt).mockImplementation(() => {
      throw new Error('invalid token');
    });

    expect(() => mapOnlineVerifyToVerifiedGrant('bad.token')).toThrow(
      GrantexTokenError,
    );
  });
});
