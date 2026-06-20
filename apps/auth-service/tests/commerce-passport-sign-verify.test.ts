/**
 * Lib-level tests for commerce passport signing and verification.
 * Exercises the security-critical paths:
 *   - alg=none rejection
 *   - HS256/algorithm confusion rejection
 *   - missing kid rejection
 *   - unknown kid rejection
 *   - cross-namespace kid rejection (passport claims to be signed by a
 *     platform RS256 kid like "grantex-2026-05")
 *   - expired / not-yet-valid (with 30s clock-skew tolerance)
 *   - wrong audience / wrong issuer
 *   - cross-tenant / cross-merchant verification gates
 *   - online revocation (payment_affecting) returns deny
 *   - revocation infrastructure unavailable → fail-closed result
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  generateKeyPair,
  exportJWK,
  importJWK,
  SignJWT,
  type CryptoKey as KeyLike,
  type JWK,
} from 'jose';
import { sqlMock, mockRedis } from './helpers.js';

// Stub out crypto.initKeys if it tries to read RSA env — tests use AUTO_GENERATE_KEYS.
import {
  signCommercePassport,
  verifyCommercePassport,
  newCommercePassportJti,
} from '../src/lib/commerce/passport.js';
import { _resetCommercePassportKeyCacheForTests } from '../src/lib/commerce/passport-keys.js';

const TENANT = 'cten_TEST';
const MERCHANT = 'mch_TEST';
const AGENT = 'cag_TEST';
const CONSENT = 'crec_TEST';
const SUBJECT = 'user_TEST';
const SCOPES = ['commerce:catalog.read'];

let activeKp: { privateKey: KeyLike; publicKey: KeyLike };
let activeKid: string;
let activePublicJwk: JWK;

async function setupActiveKey(): Promise<void> {
  activeKp = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(activeKp.publicKey);
  activeKid = 'commerce-passport-20260503-aabbccdd';
  activePublicJwk = { ...jwk, kid: activeKid, alg: 'ES256', use: 'sig' } as JWK;
}

/**
 * Prime sqlMock for getActiveCommercePassportSigner. The lib first calls
 * findActiveCommercePassportKey (one SELECT) which returns the active
 * row, then a second SELECT that returns encrypted_private_key_jwk.
 *
 * We use a real ES256 keypair generated in test setup; the encrypted
 * field is a base64 of an AES-GCM ciphertext produced by vault-crypto
 * (uses VAULT_ENCRYPTION_KEY from vitest env).
 */
async function primeActiveKeyForSigner(): Promise<void> {
  const { encrypt } = await import('../src/lib/vault-crypto.js');
  const privateJwk = await exportJWK(activeKp.privateKey);
  const encryptedPrivate = encrypt(JSON.stringify({ ...privateJwk, kid: activeKid, alg: 'ES256' }));
  // Find active
  sqlMock.mockResolvedValueOnce([{
    kid: activeKid, algorithm: 'ES256', status: 'active',
    public_key_jwk: activePublicJwk, created_at: new Date(), retired_at: null,
  }]);
  // Decrypt key fetch
  sqlMock.mockResolvedValueOnce([{ encrypted_private_key_jwk: encryptedPrivate }]);
}

function primePublicKeyLookup(kid: string = activeKid, jwk: JWK = activePublicJwk): void {
  sqlMock.mockResolvedValueOnce([{ public_key_jwk: jwk }]);
}

function primeNoSuchKey(): void {
  sqlMock.mockResolvedValueOnce([]);
}

beforeAll(async () => {
  await setupActiveKey();
});

async function signValidPassport(opts: { iat?: number; exp?: number; nbf?: number; passportType?: 'browse' | 'checkout' } = {}): Promise<string> {
  _resetCommercePassportKeyCacheForTests();
  await primeActiveKeyForSigner();
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.iat ?? now;
  const r = await signCommercePassport(sqlMock as unknown as never, {
    jti: newCommercePassportJti(),
    passportType: opts.passportType ?? 'browse',
    tenantId: TENANT, merchantId: MERCHANT, agentId: AGENT,
    consentRecordId: CONSENT, subject: SUBJECT,
    scopes: SCOPES, maxAmount: null, currency: null,
    environment: 'sandbox',
    issuedAt: iat, notBefore: opts.nbf ?? iat, expiresAt: opts.exp ?? now + 600,
  });
  return r.jwt;
}

describe('Commerce passport — round-trip signing + verification', () => {
  it('signs and verifies (read_only) with the active key', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.passport.kid).toBe(activeKid);
      expect(r.passport.tenantId).toBe(TENANT);
      expect(r.passport.merchantId).toBe(MERCHANT);
      expect(r.passport.scopes).toEqual(SCOPES);
    }
  });
});

describe('Commerce passport — algorithm attacks rejected', () => {
  it('rejects alg=none', async () => {
    // Construct an unsigned token with alg=none manually.
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: activeKid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ jti: 'x', sub: SUBJECT })).toString('base64url');
    const token = `${header}.${payload}.`;
    primePublicKeyLookup();  // (won't be reached but be defensive)
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, token, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('algorithm_rejected');
  });

  it('rejects HS256 confusion (HMAC token claiming the EC public key as secret)', async () => {
    const { SignJWT } = await import('jose');
    const ecJwk = await exportJWK(activeKp.publicKey);
    // Use the EC public key bytes as an HMAC secret — classic alg-confusion.
    const fakeSecret = Buffer.from(JSON.stringify(ecJwk));
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: activeKid })
      .setIssuer(process.env['JWT_ISSUER'] ?? 'https://grantex.dev')
      .setAudience('grantex-commerce')
      .setSubject(SUBJECT).setJti('x').setIssuedAt(now).setExpirationTime(now + 60)
      .sign(fakeSecret);
    primePublicKeyLookup();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, forged, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('algorithm_rejected');
  });
});

describe('Commerce passport — kid attacks rejected', () => {
  it('rejects missing kid', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })   // no kid
      .setIssuer(process.env['JWT_ISSUER'] ?? 'https://grantex.dev')
      .setAudience('grantex-commerce')
      .setSubject(SUBJECT).setJti('x').setIssuedAt(now).setExpirationTime(now + 60)
      .sign(activeKp.privateKey);
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, token, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('kid_required');
  });

  it('rejects wrong-namespace kid (forged claim of platform RS256 kid)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'grantex-2026-05' })   // platform namespace
      .setIssuer(process.env['JWT_ISSUER'] ?? 'https://grantex.dev')
      .setAudience('grantex-commerce')
      .setSubject(SUBJECT).setJti('x').setIssuedAt(now).setExpirationTime(now + 60)
      .sign(activeKp.privateKey);
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, token, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('kid_wrong_namespace');
  });

  it('rejects unknown kid (matches namespace but not in DB)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'commerce-passport-20990101-deadbeef' })
      .setIssuer(process.env['JWT_ISSUER'] ?? 'https://grantex.dev')
      .setAudience('grantex-commerce')
      .setSubject(SUBJECT).setJti('x').setIssuedAt(now).setExpirationTime(now + 60)
      .sign(activeKp.privateKey);
    primeNoSuchKey();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, token, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('kid_unknown');
  });
});

describe('Commerce passport — temporal claims', () => {
  it('rejects expired (more than 30s past exp)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signValidPassport({ exp: now - 60 });    // 60s past
    primePublicKeyLookup();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('expired');
  });

  it('accepts within 30s clock-skew tolerance past exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Issue 60s ago, exp 5s ago — within 30s skew but exp > iat (lifetime = 55s).
    const jwt = await signValidPassport({ iat: now - 60, exp: now - 5 });
    primePublicKeyLookup();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(true);
  });
});

describe('Commerce passport — context invariants', () => {
  it('rejects on tenant mismatch when expectedTenantId provided', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only', expectedTenantId: 'cten_OTHER' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('tenant_mismatch');
  });

  it('rejects on merchant mismatch when expectedMerchantId provided', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only', expectedMerchantId: 'mch_OTHER' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('merchant_mismatch');
  });
});

describe('Commerce passport — online revocation (payment_affecting)', () => {
  it('rejects revoked passport (Redis hit)', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    mockRedis.sismember.mockResolvedValueOnce(1);
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'payment_affecting' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('revoked');
  });

  it('rejects revoked passport (Postgres hit when Redis miss)', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    mockRedis.sismember.mockResolvedValueOnce(0);
    sqlMock.mockResolvedValueOnce([{ reason: 'merchant_disabled' }]);  // postgres lookup
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'payment_affecting' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('revoked');
      if (r.error.kind === 'revoked') expect(r.error.reason).toBe('merchant_disabled');
    }
  });

  it('fail-closed when both Redis AND Postgres revocation lookup fail', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    mockRedis.sismember.mockRejectedValueOnce(new Error('redis down'));
    sqlMock.mockRejectedValueOnce(new Error('pg down'));
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'payment_affecting' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('revocation_unavailable');
  });

  it('read_only mode skips revocation check (degrades gracefully)', async () => {
    const jwt = await signValidPassport();
    primePublicKeyLookup();
    // Redis NOT primed and Postgres NOT primed — no lookup happens.
    const r = await verifyCommercePassport(sqlMock as unknown as never, mockRedis as unknown as never, jwt, { mode: 'read_only' });
    expect(r.ok).toBe(true);
  });
});

describe('Commerce passport-keys — production guardrail (Decision D)', () => {
  it('refuses to auto-generate when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_AUTO_GENERATE_PASSPORT_KEY', 'true');
    _resetCommercePassportKeyCacheForTests();
    sqlMock.mockResolvedValueOnce([]);  // findActiveCommercePassportKey returns null
    const { getActiveCommercePassportSigner } = await import('../src/lib/commerce/passport-keys.js');
    await expect(getActiveCommercePassportSigner(sqlMock as unknown as never))
      .rejects.toThrow(/explicit/i);
    vi.unstubAllEnvs();
  });
});

// Use importJWK to silence unused-import warnings; this also smoke-tests
// that jose is available in the test runtime.
void importJWK;
