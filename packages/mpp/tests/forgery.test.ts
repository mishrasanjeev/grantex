import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as jose from 'jose';
import { verifyPassport, clearJwksCache } from '../src/verifier.js';
import type { AgentPassportCredential } from '../src/types.js';

/**
 * Regression suite for passport forgery.
 *
 * The credential envelope is transported base64url-encoded in a client-supplied
 * header, so every field in it is attacker-controlled. Only `proof.proofValue`
 * is signed. If verification reads authorization-relevant claims off the
 * envelope, any holder of one legitimately-issued passport can lift its proof,
 * staple it to a self-written envelope, and mint arbitrary authority.
 */

let rsaKeyPair: Awaited<ReturnType<typeof jose.generateKeyPair>>;
let jwks: jose.JSONWebKeySet;

async function setupKeys(): Promise<void> {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
  rsaKeyPair = { publicKey, privateKey };
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = 'key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwks = { keys: [jwk] };
}

function mockFetchJwks() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (typeof url === 'string' && url.includes('jwks.json')) {
      return { ok: true, status: 200, json: async () => jwks };
    }
    return { ok: false, status: 404 };
  });
}

/** A modest, legitimately-issued passport: two categories, $50 ceiling. */
function lowPrivilegeSubject(): AgentPassportCredential['credentialSubject'] {
  return {
    id: 'did:grantex:ag_attacker',
    type: 'AIAgent',
    humanPrincipal: 'did:grantex:user_attacker',
    organizationDID: 'did:web:attacker.example',
    grantId: 'grnt_low',
    allowedMPPCategories: ['inference'],
    maxTransactionAmount: { amount: 50, currency: 'USDC' },
    paymentRails: ['tempo'],
    delegationDepth: 0,
  };
}

/**
 * Mint a real passport the way the auth service does: the proof is a VC-JWT
 * whose `vc` claim carries the subject and whose registered claims carry the
 * envelope (see apps/auth-service/src/routes/passport.ts).
 */
async function issueRealPassport(
  subject: AgentPassportCredential['credentialSubject'],
): Promise<AgentPassportCredential> {
  const passportId = 'urn:grantex:passport:REAL01';
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 86_400_000);

  const credentialStatus: AgentPassportCredential['credentialStatus'] = {
    id: 'https://api.grantex.dev/v1/credentials/status/vcsl_01#0',
    type: 'StatusList2021Entry',
    statusPurpose: 'revocation',
    statusListIndex: '0',
    statusListCredential: 'https://api.grantex.dev/v1/credentials/status/vcsl_01',
  };

  const proofValue = await new jose.SignJWT({
    vc: {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        'https://grantex.dev/contexts/mpp/v1',
      ],
      type: ['VerifiableCredential', 'AgentPassportCredential'],
      credentialSubject: subject,
      credentialStatus,
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })
    .setIssuer('did:web:grantex.dev')
    .setSubject(subject.id)
    .setJti(passportId)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(rsaKeyPair.privateKey);

  return {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      'https://grantex.dev/contexts/mpp/v1',
    ],
    type: ['VerifiableCredential', 'AgentPassportCredential'],
    id: passportId,
    issuer: 'did:web:grantex.dev',
    validFrom: now.toISOString(),
    validUntil: expiresAt.toISOString(),
    credentialSubject: subject,
    credentialStatus,
    proof: {
      type: 'Ed25519Signature2020',
      created: now.toISOString(),
      verificationMethod: 'did:web:grantex.dev#key-2',
      proofPurpose: 'assertionMethod',
      proofValue,
    },
  };
}

function encode(credential: AgentPassportCredential): string {
  return Buffer.from(JSON.stringify(credential)).toString('base64url');
}

describe('passport forgery via envelope substitution', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
    vi.stubGlobal('fetch', mockFetchJwks());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts the genuine passport it was issued', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());

    const result = await verifyPassport(encode(real));

    expect(result.valid).toBe(true);
    expect(result.allowedCategories).toEqual(['inference']);
    expect(result.maxTransactionAmount).toEqual({ amount: 50, currency: 'USDC' });
  });

  it('rejects a self-written envelope carrying a real proof', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());

    // Same signed proof, envelope rewritten to grant every category and a
    // 1,000,000 USDC ceiling.
    const forged: AgentPassportCredential = {
      ...real,
      credentialSubject: {
        ...lowPrivilegeSubject(),
        allowedMPPCategories: [
          'inference', 'compute', 'data', 'storage',
          'search', 'media', 'delivery', 'browser', 'general',
        ],
        maxTransactionAmount: { amount: 1_000_000, currency: 'USDC' },
      },
    };

    await expect(verifyPassport(encode(forged))).rejects.toThrow(
      expect.objectContaining({ code: 'CREDENTIAL_MISMATCH' }),
    );
  });

  it('does not let a forged envelope satisfy a category requirement', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());
    const forged: AgentPassportCredential = {
      ...real,
      credentialSubject: {
        ...lowPrivilegeSubject(),
        allowedMPPCategories: ['inference', 'delivery'],
      },
    };

    await expect(
      verifyPassport(encode(forged), { requiredCategories: ['delivery'] }),
    ).rejects.toThrow(expect.objectContaining({ code: 'CREDENTIAL_MISMATCH' }));
  });

  it('does not let a forged envelope satisfy an amount requirement', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());
    const forged: AgentPassportCredential = {
      ...real,
      credentialSubject: {
        ...lowPrivilegeSubject(),
        maxTransactionAmount: { amount: 999_999, currency: 'USDC' },
      },
    };

    await expect(
      verifyPassport(encode(forged), { maxAmount: 10_000 }),
    ).rejects.toThrow(expect.objectContaining({ code: 'CREDENTIAL_MISMATCH' }));
  });

  it('rejects an envelope that reassigns the human principal', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());
    const forged: AgentPassportCredential = {
      ...real,
      credentialSubject: {
        ...lowPrivilegeSubject(),
        humanPrincipal: 'did:grantex:user_victim',
      },
    };

    await expect(verifyPassport(encode(forged))).rejects.toThrow(
      expect.objectContaining({ code: 'CREDENTIAL_MISMATCH' }),
    );
  });

  it('rejects an envelope that renames the passport id', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());
    const forged: AgentPassportCredential = { ...real, id: 'urn:grantex:passport:OTHER' };

    await expect(verifyPassport(encode(forged))).rejects.toThrow(
      expect.objectContaining({ code: 'CREDENTIAL_MISMATCH' }),
    );
  });

  it('rejects an envelope that extends validUntil past the signed exp', async () => {
    const subject = lowPrivilegeSubject();
    const now = new Date();
    const proofValue = await new jose.SignJWT({
      vc: { credentialSubject: subject },
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })
      .setIssuer('did:web:grantex.dev')
      .setJti('urn:grantex:passport:REAL01')
      .setIssuedAt(Math.floor(now.getTime() / 1000) - 7200)
      // Signed proof expired an hour ago.
      .setExpirationTime(Math.floor(now.getTime() / 1000) - 3600)
      .sign(rsaKeyPair.privateKey);

    const real = await issueRealPassport(subject);
    const forged: AgentPassportCredential = {
      ...real,
      // Envelope claims another decade of validity.
      validUntil: new Date(now.getTime() + 10 * 365 * 86_400_000).toISOString(),
      proof: { ...real.proof, proofValue },
    };

    await expect(verifyPassport(encode(forged))).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPORT_EXPIRED' }),
    );
  });

  it('rejects a passport whose validity window has not opened yet', async () => {
    const subject = lowPrivilegeSubject();
    const real = await issueRealPassport(subject);
    const startsAt = new Date(Date.now() + 3_600_000);

    const proofValue = await new jose.SignJWT({ vc: { credentialSubject: subject } })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })
      .setIssuer('did:web:grantex.dev')
      .setJti(real.id)
      .setIssuedAt(Math.floor(startsAt.getTime() / 1000))
      .setExpirationTime(Math.floor(startsAt.getTime() / 1000) + 86_400)
      .sign(rsaKeyPair.privateKey);

    const notYetValid: AgentPassportCredential = {
      ...real,
      validFrom: startsAt.toISOString(),
      validUntil: new Date(startsAt.getTime() + 86_400_000).toISOString(),
      proof: { ...real.proof, proofValue },
    };

    await expect(verifyPassport(encode(notYetValid))).rejects.toThrow(
      expect.objectContaining({ code: 'PASSPORT_NOT_YET_VALID' }),
    );
  });
});

describe('revocation check failure handling', () => {
  beforeEach(async () => {
    await setupKeys();
    clearJwksCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails closed when the revocation endpoint is unavailable', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('jwks.json')) {
        return { ok: true, status: 200, json: async () => jwks };
      }
      return { ok: false, status: 503 };
    }));

    await expect(
      verifyPassport(encode(real), {
        checkRevocation: true,
        revocationEndpoint: 'https://api.grantex.dev/revocation',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'REVOCATION_CHECK_FAILED' }));
  });

  it('fails closed when the revocation endpoint throws', async () => {
    const real = await issueRealPassport(lowPrivilegeSubject());

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('jwks.json')) {
        return { ok: true, status: 200, json: async () => jwks };
      }
      throw new Error('ECONNREFUSED');
    }));

    await expect(
      verifyPassport(encode(real), {
        checkRevocation: true,
        revocationEndpoint: 'https://api.grantex.dev/revocation',
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'REVOCATION_CHECK_FAILED' }));
  });
});
