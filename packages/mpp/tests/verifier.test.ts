import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as jose from 'jose';
import { verifyPassport, requireAgentPassport, clearJwksCache } from '../src/verifier.js';
import { PassportVerificationError } from '../src/errors.js';
import type { AgentPassportCredential } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCredential(overrides?: Partial<AgentPassportCredential>): AgentPassportCredential {
  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://grantex.dev/contexts/mpp/v1',
    ],
    type: ['VerifiableCredential', 'AgentPassportCredential'],
    id: 'urn:grantex:passport:01HXYZ',
    issuer: 'did:web:grantex.dev',
    validFrom: new Date(Date.now() - 3600_000).toISOString(),
    validUntil: new Date(Date.now() + 86400_000).toISOString(),
    credentialSubject: {
      id: 'did:grantex:ag_01HXYZ',
      type: 'AIAgent',
      humanPrincipal: 'did:grantex:user_01ABC',
      organizationDID: 'did:web:acme.com',
      grantId: 'grnt_01HXYZ',
      allowedMPPCategories: ['inference', 'compute'],
      maxTransactionAmount: { amount: 50, currency: 'USDC' },
      paymentRails: ['tempo'],
      delegationDepth: 0,
    },
    credentialStatus: {
      id: 'https://api.grantex.dev/v1/credentials/status/vcsl_01#0',
      type: 'StatusList2021Entry',
      statusPurpose: 'revocation',
      statusListIndex: '0',
      statusListCredential: 'https://api.grantex.dev/v1/credentials/status/vcsl_01',
    },
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      verificationMethod: 'did:web:grantex.dev#key-2',
      proofPurpose: 'assertionMethod',
      proofValue: '', // Will be filled in beforeEach
    },
    ...overrides,
  };
}

function encodeCredential(credential: AgentPassportCredential): string {
  return Buffer.from(JSON.stringify(credential)).toString('base64url');
}

let rsaKeyPair: { publicKey: jose.KeyLike; privateKey: jose.KeyLike };
let jwks: jose.JSONWebKeySet;

// Generate a test RSA key pair and JWKS for signature verification
async function setupKeys() {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  rsaKeyPair = { publicKey, privateKey } as unknown as { publicKey: jose.KeyLike; privateKey: jose.KeyLike };
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = 'key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwks = { keys: [jwk] };
}

async function signCredential(credential: AgentPassportCredential): Promise<AgentPassportCredential> {
  const jwt = await new jose.SignJWT({ vc: credential })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer('did:web:grantex.dev')
    .setSubject(credential.credentialSubject.id)
    .setJti(credential.id)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(rsaKeyPair.privateKey as unknown as jose.KeyLike);

  return {
    ...credential,
    proof: {
      ...credential.proof,
      proofValue: jwt,
    },
  };
}

function mockFetchJwks() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('jwks.json')) {
      return {
        ok: true,
        status: 200,
        json: async () => jwks,
      };
    }
    return { ok: false, status: 404 };
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('verifyPassport', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('verifies a valid, non-expired credential', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    const result = await verifyPassport(encoded);

    expect(result.valid).toBe(true);
    expect(result.passportId).toBe('urn:grantex:passport:01HXYZ');
    expect(result.agentDID).toBe('did:grantex:ag_01HXYZ');
    expect(result.humanDID).toBe('did:grantex:user_01ABC');
    expect(result.organizationDID).toBe('did:web:acme.com');
    expect(result.grantId).toBe('grnt_01HXYZ');
    expect(result.allowedCategories).toEqual(['inference', 'compute']);
    expect(result.maxTransactionAmount).toEqual({ amount: 50, currency: 'USDC' });
    expect(result.delegationDepth).toBe(0);
    expect(result.issuer).toBe('did:web:grantex.dev');
  });

  it('throws PASSPORT_EXPIRED for expired credential', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(
      makeCredential({
        validUntil: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({
        code: 'PASSPORT_EXPIRED',
      }),
    );
  });

  it('throws INVALID_SIGNATURE for tampered credential', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(makeCredential());
    // Tamper with the signature
    credential.proof.proofValue = credential.proof.proofValue.slice(0, -5) + 'XXXXX';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({
        code: 'INVALID_SIGNATURE',
      }),
    );
  });

  it('throws CATEGORY_MISMATCH when required categories not present', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    await expect(
      verifyPassport(encoded, { requiredCategories: ['storage'] }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'CATEGORY_MISMATCH',
      }),
    );
  });

  it('throws AMOUNT_EXCEEDED when passport max amount is below required', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    await expect(
      verifyPassport(encoded, { maxAmount: 100 }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'AMOUNT_EXCEEDED',
      }),
    );
  });

  it('throws MISSING_PASSPORT when empty string provided', async () => {
    await expect(verifyPassport('')).rejects.toThrow(
      expect.objectContaining({
        code: 'MISSING_PASSPORT',
      }),
    );
  });

  it('throws UNTRUSTED_ISSUER for unknown issuer', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(
      makeCredential({ issuer: 'did:web:evil.com' }),
    );
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({
        code: 'UNTRUSTED_ISSUER',
      }),
    );
  });

  it('throws MALFORMED_CREDENTIAL for invalid base64url', async () => {
    await expect(verifyPassport('not-valid-base64!')).rejects.toThrow(
      PassportVerificationError,
    );
  });
});

describe('requireAgentPassport', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('populates req.agentPassport on valid request', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    const middleware = requireAgentPassport();

    const req = { headers: { 'x-grantex-passport': encoded } } as unknown as import('express').Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as import('express').Response;
    const next = vi.fn();

    await (middleware as Function)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.agentPassport).toBeDefined();
    expect(req.agentPassport!.valid).toBe(true);
    expect(req.agentPassport!.agentDID).toBe('did:grantex:ag_01HXYZ');
  });

  it('returns 403 when X-Grantex-Passport header is missing', async () => {
    const middleware = requireAgentPassport();

    const req = { headers: {} } as unknown as import('express').Request;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as import('express').Response;
    const next = vi.fn();

    await (middleware as Function)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'MISSING_PASSPORT' }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
