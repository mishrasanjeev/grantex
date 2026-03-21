/**
 * Tests covering all untested code paths in the MPP package.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as jose from 'jose';
import {
  categoriesToScopes,
  scopesToCategories,
  MPP_CATEGORY_TO_GRANTEX_SCOPE,
  ALL_MPP_CATEGORIES,
} from '../src/category-mapping.js';
import { createMppPassportMiddleware, encodePassport } from '../src/middleware.js';
import { issuePassport } from '../src/passport.js';
import { lookupOrgTrust, clearTrustRegistryCache } from '../src/trust-registry.js';
import { verifyPassport, requireAgentPassport, clearJwksCache } from '../src/verifier.js';
import { PassportVerificationError } from '../src/errors.js';
import type { AgentPassportCredential, IssuedPassport, MPPCategory } from '../src/types.js';

// ─── Shared helpers ──────────────────────────────────────────────────────────

function makePassport(overrides?: Partial<IssuedPassport>): IssuedPassport {
  return {
    passportId: 'pp_test',
    credential: {} as AgentPassportCredential,
    encodedCredential: 'test-encoded-credential',
    expiresAt: new Date(Date.now() + 86400_000),
    ...overrides,
  };
}

function makeCredential(overrides?: Partial<AgentPassportCredential>): AgentPassportCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://grantex.dev/contexts/mpp/v1'],
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
      proofValue: '',
    },
    ...overrides,
  };
}

function encodeCredential(credential: AgentPassportCredential): string {
  return Buffer.from(JSON.stringify(credential)).toString('base64url');
}

let rsaKeyPair: { publicKey: jose.KeyLike; privateKey: jose.KeyLike };
let jwks: jose.JSONWebKeySet;

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

  return { ...credential, proof: { ...credential.proof, proofValue: jwt } };
}

function mockFetchJwks() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('jwks.json')) {
      return { ok: true, status: 200, json: async () => jwks };
    }
    return { ok: false, status: 404 };
  });
}

// ─── category-mapping.ts ─────────────────────────────────────────────────────

describe('category-mapping — categoriesToScopes', () => {
  it('converts all 9 categories to scopes', () => {
    const scopes = categoriesToScopes(ALL_MPP_CATEGORIES);
    expect(scopes).toHaveLength(9);
    expect(scopes).toContain('payments:mpp:inference');
    expect(scopes).toContain('payments:mpp:compute');
    expect(scopes).toContain('payments:mpp:data');
    expect(scopes).toContain('payments:mpp:storage');
    expect(scopes).toContain('payments:mpp:search');
    expect(scopes).toContain('payments:mpp:media');
    expect(scopes).toContain('payments:mpp:delivery');
    expect(scopes).toContain('payments:mpp:browser');
    expect(scopes).toContain('payments:mpp:general');
  });

  it('converts a subset of categories', () => {
    const scopes = categoriesToScopes(['inference', 'compute']);
    expect(scopes).toEqual(['payments:mpp:inference', 'payments:mpp:compute']);
  });

  it('returns empty array for empty input', () => {
    expect(categoriesToScopes([])).toEqual([]);
  });
});

describe('category-mapping — scopesToCategories', () => {
  it('converts all 9 scopes back to categories', () => {
    const scopes = ALL_MPP_CATEGORIES.map((c) => MPP_CATEGORY_TO_GRANTEX_SCOPE[c]);
    const categories = scopesToCategories(scopes);
    expect(categories).toEqual(ALL_MPP_CATEGORIES);
  });

  it('filters out non-mpp scopes', () => {
    const categories = scopesToCategories([
      'payments:mpp:inference',
      'calendar:read',
      'email:send',
      'payments:mpp:compute',
    ]);
    expect(categories).toEqual(['inference', 'compute']);
  });

  it('returns empty for no matching scopes', () => {
    expect(scopesToCategories(['calendar:read', 'email:send'])).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(scopesToCategories([])).toEqual([]);
  });

  it('ignores unknown mpp sub-scopes', () => {
    const categories = scopesToCategories(['payments:mpp:nonexistent']);
    expect(categories).toEqual([]);
  });
});

// ─── middleware.ts ────────────────────────────────────────────────────────────

describe('middleware — expired passport without onRefresh', () => {
  it('throws when passport is expired and no onRefresh provided', async () => {
    const passport = makePassport({
      expiresAt: new Date(Date.now() - 10_000), // expired
    });

    const mw = createMppPassportMiddleware({ passport });
    const req = new Request('https://api.example.com/pay', { method: 'POST' });

    await expect(mw(req)).rejects.toThrow('has expired');
  });
});

describe('middleware — encodePassport', () => {
  it('returns the encodedCredential field', () => {
    const passport = makePassport({ encodedCredential: 'my-encoded-cred' });
    expect(encodePassport(passport)).toBe('my-encoded-cred');
  });
});

describe('middleware — proactive refresh error is non-fatal', () => {
  it('uses current passport when background refresh fails', async () => {
    const passport = makePassport({
      expiresAt: new Date(Date.now() + 100_000), // within threshold
    });

    const onRefresh = vi.fn().mockRejectedValue(new Error('refresh failed'));

    const mw = createMppPassportMiddleware({
      passport,
      autoRefreshThreshold: 200, // 200s threshold, passport expires in 100s
      onRefresh,
    });

    const req = new Request('https://api.example.com/pay');
    const result = await mw(req);

    // Should still work with current passport
    expect(result.headers.get('X-Grantex-Passport')).toBe('test-encoded-credential');
    expect(onRefresh).toHaveBeenCalled();

    // Wait for background promise to settle
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('middleware — concurrent refresh dedup', () => {
  it('does not call onRefresh twice while one is in progress', async () => {
    const passport = makePassport({
      expiresAt: new Date(Date.now() + 50_000), // within threshold
    });

    let resolveRefresh: ((p: IssuedPassport) => void) | null = null;
    const onRefresh = vi.fn().mockImplementation(() => {
      return new Promise<IssuedPassport>((resolve) => {
        resolveRefresh = resolve;
      });
    });

    const mw = createMppPassportMiddleware({
      passport,
      autoRefreshThreshold: 200,
      onRefresh,
    });

    // Send two concurrent requests
    const req1 = mw(new Request('https://api.example.com/a'));
    const req2 = mw(new Request('https://api.example.com/b'));

    await Promise.all([req1, req2]);

    // onRefresh should only be called once (dedup via refreshInProgress)
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Resolve the pending refresh
    if (resolveRefresh) resolveRefresh(makePassport({ encodedCredential: 'refreshed' }));
    await new Promise((r) => setTimeout(r, 50));
  });
});

// ─── passport.ts ─────────────────────────────────────────────────────────────

describe('passport — issuePassport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes paymentRails when provided', async () => {
    const capturedBody = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody(JSON.parse(init.body as string));
      return {
        ok: true,
        json: async () => ({
          passportId: 'pp_1',
          credential: {},
          encodedCredential: 'enc',
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        }),
      };
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await issuePassport(client, {
      agentId: 'ag_1',
      grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      paymentRails: ['tempo', 'x402'],
    });

    expect(capturedBody).toHaveBeenCalledWith(
      expect.objectContaining({ paymentRails: ['tempo', 'x402'] }),
    );
  });

  it('includes parentPassportId when provided', async () => {
    const capturedBody = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody(JSON.parse(init.body as string));
      return {
        ok: true,
        json: async () => ({
          passportId: 'pp_1',
          credential: {},
          encodedCredential: 'enc',
          expiresAt: new Date(Date.now() + 86400_000).toISOString(),
        }),
      };
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await issuePassport(client, {
      agentId: 'ag_1',
      grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      parentPassportId: 'pp_parent',
    });

    expect(capturedBody).toHaveBeenCalledWith(
      expect.objectContaining({ parentPassportId: 'pp_parent' }),
    );
  });

  it('uses generic error when response JSON parse fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error('bad json'); },
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await expect(issuePassport(client, {
      agentId: 'ag_1',
      grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
    })).rejects.toThrow('Failed to issue passport: 500');
  });

  it('uses error message from response body when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Agent not found', code: 'NOT_FOUND' }),
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await expect(issuePassport(client, {
      agentId: 'ag_1',
      grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
    })).rejects.toThrow('Agent not found');
  });

  it('parses expiresIn with hours unit', async () => {
    const capturedBody = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody(JSON.parse(init.body as string));
      return {
        ok: true,
        json: async () => ({
          passportId: 'pp_1',
          credential: {},
          encodedCredential: 'enc',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      };
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await issuePassport(client, {
      agentId: 'ag_1',
      grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      expiresIn: '12h',
    });

    expect(capturedBody).toHaveBeenCalledWith(
      expect.objectContaining({ expiresIn: '12h' }),
    );
  });

  it('parses expiresIn with days unit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        passportId: 'pp_1', credential: {}, encodedCredential: 'enc',
        expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      }),
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    // 30d = 720h which is exactly MAX_EXPIRY_HOURS — should pass
    await expect(issuePassport(client, {
      agentId: 'ag_1', grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      expiresIn: '30d',
    })).resolves.toBeDefined();
  });

  it('rejects expiresIn exceeding max (31d)', async () => {
    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await expect(issuePassport(client, {
      agentId: 'ag_1', grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      expiresIn: '31d',
    })).rejects.toThrow('exceeds maximum');
  });

  it('rejects invalid expiresIn format', async () => {
    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    await expect(issuePassport(client, {
      agentId: 'ag_1', grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      expiresIn: 'banana',
    })).rejects.toThrow('Invalid expiresIn format');
  });

  it('parses expiresIn with minutes and seconds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        passportId: 'pp_1', credential: {}, encodedCredential: 'enc',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    }));

    const client = { _baseUrl: 'https://test.api', _apiKey: 'key123' } as never;
    // 60m = 1 hour
    await expect(issuePassport(client, {
      agentId: 'ag_1', grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      expiresIn: '60m',
    })).resolves.toBeDefined();

    // 3600s = 1 hour
    await expect(issuePassport(client, {
      agentId: 'ag_1', grantId: 'grnt_1',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 10, currency: 'USDC' },
      expiresIn: '3600s',
    })).resolves.toBeDefined();
  });
});

// ─── trust-registry.ts ───────────────────────────────────────────────────────

describe('trust-registry — error responses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearTrustRegistryCache();
  });

  it('throws on 500 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }));

    await expect(lookupOrgTrust('did:web:broken.com')).rejects.toThrow(
      'Trust registry lookup failed: 500',
    );
  });

  it('throws on 503 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));

    await expect(lookupOrgTrust('did:web:unavailable.com')).rejects.toThrow(
      'Trust registry lookup failed: 503',
    );
  });

  it('throws on 400 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
    }));

    await expect(lookupOrgTrust('did:web:bad.com')).rejects.toThrow(
      'Trust registry lookup failed: 400',
    );
  });
});

// ─── verifier.ts ─────────────────────────────────────────────────────────────

describe('verifier — validateStructure individual fields', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws MALFORMED_CREDENTIAL when @context is missing', async () => {
    const credential = makeCredential();
    delete (credential as Record<string, unknown>)['@context'];
    credential.proof.proofValue = 'dummy';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });

  it('throws MALFORMED_CREDENTIAL when type is missing AgentPassportCredential', async () => {
    const credential = makeCredential({ type: ['VerifiableCredential'] });
    credential.proof.proofValue = 'dummy';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });

  it('throws MALFORMED_CREDENTIAL when credentialSubject is missing', async () => {
    const credential = makeCredential();
    delete (credential as Record<string, unknown>)['credentialSubject'];
    credential.proof.proofValue = 'dummy';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });

  it('throws MALFORMED_CREDENTIAL when proof is missing', async () => {
    const credential = makeCredential();
    delete (credential as Record<string, unknown>)['proof'];
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });

  it('throws MALFORMED_CREDENTIAL when id is missing', async () => {
    const credential = makeCredential();
    delete (credential as Record<string, unknown>)['id'];
    credential.proof.proofValue = 'dummy';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });

  it('throws MALFORMED_CREDENTIAL when issuer is missing', async () => {
    const credential = makeCredential();
    delete (credential as Record<string, unknown>)['issuer'];
    credential.proof.proofValue = 'dummy';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });

  it('throws MALFORMED_CREDENTIAL when validUntil is missing', async () => {
    const credential = makeCredential();
    delete (credential as Record<string, unknown>)['validUntil'];
    credential.proof.proofValue = 'dummy';
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'MALFORMED_CREDENTIAL' }),
    );
  });
});

describe('verifier — MALFORMED_CREDENTIAL exact code for invalid base64url', () => {
  it('returns code MALFORMED_CREDENTIAL', async () => {
    try {
      await verifyPassport('!!!invalid!!!');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PassportVerificationError);
      expect((err as PassportVerificationError).code).toBe('MALFORMED_CREDENTIAL');
    }
  });
});

describe('verifier — revocation check', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws when checkRevocation=true but no revocationEndpoint', async () => {
    const fetchMock = mockFetchJwks();
    vi.stubGlobal('fetch', fetchMock);

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    await expect(
      verifyPassport(encoded, { checkRevocation: true }),
    ).rejects.toThrow('revocationEndpoint is required when checkRevocation is true');
  });

  it('throws PASSPORT_REVOKED when revocation endpoint says invalid', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('jwks.json')) {
        return { ok: true, status: 200, json: async () => jwks };
      }
      if (typeof url === 'string' && url.includes('revocation')) {
        return { ok: true, status: 200, json: async () => ({ valid: false }) };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', fetchMock);

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    await expect(
      verifyPassport(encoded, {
        checkRevocation: true,
        revocationEndpoint: 'https://api.grantex.dev/revocation',
      }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPORT_REVOKED' }),
    );
  });

  it('passes when revocation endpoint says valid', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('jwks.json')) {
        return { ok: true, status: 200, json: async () => jwks };
      }
      if (typeof url === 'string' && url.includes('revocation')) {
        return { ok: true, status: 200, json: async () => ({ valid: true }) };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', fetchMock);

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    const result = await verifyPassport(encoded, {
      checkRevocation: true,
      revocationEndpoint: 'https://api.grantex.dev/revocation',
    });

    expect(result.valid).toBe(true);
  });
});

describe('verifier — signature fallback: missing proofValue', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws INVALID_SIGNATURE when proofValue is empty and compactVerify fails', async () => {
    vi.stubGlobal('fetch', mockFetchJwks());

    const credential = makeCredential();
    credential.proof.proofValue = ''; // empty
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
    );
  });
});

describe('requireAgentPassport — non-PassportVerificationError', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls next(err) for non-PassportVerificationError', async () => {
    // Make verifyPassport throw a generic Error by providing a token
    // that triggers a code path throwing a plain Error (not PassportVerificationError)
    // The easiest way: checkRevocation=true but no endpoint -> throws plain Error
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('jwks.json')) {
        return { ok: true, status: 200, json: async () => jwks };
      }
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', fetchMock);
    await setupKeys();
    clearJwksCache();

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    const middleware = requireAgentPassport({
      checkRevocation: true,
      // no revocationEndpoint → throws plain Error
    });

    const req = { headers: { 'x-grantex-passport': encoded } } as unknown as import('express').Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as import('express').Response;
    const next = vi.fn();

    await (middleware as Function)(req, res, next);

    // Should call next(err) with the plain Error, not res.status(403)
    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('verifier — JWKS fetch failure', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws INVALID_SIGNATURE when JWKS endpoint returns non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    }));

    const credential = await signCredential(makeCredential());
    const encoded = encodeCredential(credential);

    await expect(verifyPassport(encoded)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
    );
  });
});
