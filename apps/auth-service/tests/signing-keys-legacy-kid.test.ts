/**
 * Tokens signed before 0.6 carry the RS256 kid `grantex-YYYY-MM` of the month
 * their issuing process started. Upgrading, restarting in a new month, or
 * running instances started in different months must not stop them verifying.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
  type CryptoKey,
} from 'jose';
import { config, signingKeyConfigErrors, signingKeyConfigWarnings } from '../src/config.js';
import { buildJwks, getKeyPair, initKeys, signGrantToken, verifyGrantToken } from '../src/lib/crypto.js';
import {
  LEGACY_KID_RE,
  SigningKeyRing,
  legacyKidsForWindow,
  loadEnvSigningKeyRing,
  publishedSigningJwks,
  resolvePlatformVerificationKey,
  setLegacyKidPolicy,
  setSigningKeyRing,
  signingKid,
  thumbprintKid,
  type EnvKeyRingOptions,
} from '../src/lib/signing-keys.js';
import { decryptWithContext, encryptWithContext } from '../src/lib/vault-crypto.js';
import { deriveSsoStateKey } from '../src/lib/sso-state-key.js';

let rsaPem: string;
let rsaPem2: string;
let ecPem: string;
let rsaPrivate: CryptoKey;

beforeAll(async () => {
  const rsa = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  rsaPrivate = rsa.privateKey;
  rsaPem = await exportPKCS8(rsa.privateKey);
  rsaPem2 = await exportPKCS8((await generateKeyPair('RS256', { modulusLength: 2048, extractable: true })).privateKey);
  ecPem = await exportPKCS8((await generateKeyPair('ES256', { extractable: true })).privateKey);
});

afterEach(async () => {
  vi.useRealTimers();
  await initKeys();
});

const env = (overrides: Partial<EnvKeyRingOptions> = {}): EnvKeyRingOptions => ({
  alg: 'RS256', rsaPrivateKey: rsaPem, ecPrivateKey: null, autoGenerate: false,
  verificationPublicKeys: null, legacyKidKey: null, ...overrides,
});

/** A token as signed by the pre-0.6 auth service: RS256, kid grantex-YYYY-MM. */
async function preUpgradeToken(kid: string | undefined, key: CryptoKey = rsaPrivate): Promise<string> {
  return new SignJWT({ agt: 'did:grantex:ag_old', dev: 'dev_old', scp: ['read'], scope: 'read', grnt: 'grnt_old' })
    .setProtectedHeader(kid === undefined ? { alg: 'RS256', typ: 'at+jwt' } : { alg: 'RS256', kid, typ: 'at+jwt' })
    .setIssuer(config.jwtIssuer).setSubject('user_old').setJti('tok_old')
    .setIssuedAt(Math.floor(Date.parse('2026-09-30T23:30:00Z') / 1000))
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(key);
}

async function instance(startedAt: string, overrides: Partial<EnvKeyRingOptions> = {}, months = 13, transitionSeconds = 900): Promise<SigningKeyRing> {
  const ring = await loadEnvSigningKeyRing(env(overrides));
  setLegacyKidPolicy({ months, transitionSeconds, startedAt: new Date(startedAt) });
  setSigningKeyRing(ring);
  return ring;
}

describe('pre-0.6 tokens keep verifying across months and instances', () => {
  it('a token signed at 2026-09-30 with kid grantex-2026-09 verifies at 2026-10-01', async () => {
    const token = await preUpgradeToken('grantex-2026-09');
    await instance('2026-10-01T00:05:00Z');
    await expect(verifyGrantToken(token)).resolves.toMatchObject({ sub: 'user_old', grnt: 'grnt_old' });
  });

  it('any grantex-YYYY-MM kid, and a missing kid, resolve to the legacy RSA key', async () => {
    await instance('2027-03-15T00:00:00Z');
    for (const kid of ['grantex-2026-01', 'grantex-2026-09', 'grantex-2027-03', undefined]) {
      await expect(verifyGrantToken(await preUpgradeToken(kid))).resolves.toMatchObject({ sub: 'user_old' });
    }
  });

  it('a legacy kid does not verify a token signed by another RSA key', async () => {
    const foreign = await generateKeyPair('RS256', { modulusLength: 2048 });
    await instance('2026-10-01T00:00:00Z');
    await expect(verifyGrantToken(await preUpgradeToken('grantex-2026-09', foreign.privateKey))).rejects.toThrow();
  });

  it('tokens from two instances started in different months verify on both', async () => {
    const september = await instance('2026-09-30T23:59:00Z');
    const fromSeptember = await signGrantToken({ sub: 'u', agt: 'did:grantex:a', dev: 'd', scp: ['read'], jti: 't1', exp: Math.floor(Date.now() / 1000) + 600 });
    const october = await instance('2026-10-01T00:01:00Z');
    const fromOctober = await signGrantToken({ sub: 'u', agt: 'did:grantex:a', dev: 'd', scp: ['read'], jti: 't2', exp: Math.floor(Date.now() / 1000) + 600 });

    expect(september.active.kid).toBe(october.active.kid);
    for (const ring of [september, october]) {
      setSigningKeyRing(ring);
      await expect(verifyGrantToken(fromSeptember)).resolves.toBeDefined();
      await expect(verifyGrantToken(fromOctober)).resolves.toBeDefined();
    }
  });

  it('the JWK Set served at 2026-10-01 lets a stock verifier accept the 2026-09 token', async () => {
    await instance('2026-10-01T00:00:00Z');
    const jwks = { keys: publishedSigningJwks(new Date('2026-10-01T00:00:00Z')) };
    const kids = jwks.keys.map((key) => key['kid']);
    expect(kids).toContain('grantex-2026-09');
    expect(kids).toContain('grantex-2026-10');
    expect(kids).toContain('grantex-2025-10');
    expect(kids).not.toContain('grantex-2025-09');
    expect(kids.filter((kid) => LEGACY_KID_RE.test(String(kid)))).toHaveLength(13);
    for (const key of jwks.keys) {
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      expect(key['d']).toBeUndefined();
    }
    const { payload } = await jwtVerify(await preUpgradeToken('grantex-2026-09'), createLocalJWKSet(jwks), {
      algorithms: ['RS256', 'ES256'], issuer: config.jwtIssuer,
    });
    expect(payload.sub).toBe('user_old');
  });

  it('JWT_LEGACY_KID_MONTHS=0 publishes no aliases and signs with the thumbprint kid at once', async () => {
    await instance('2026-10-01T00:00:00Z', {}, 0);
    expect(publishedSigningJwks(new Date('2026-10-01T00:00:00Z'))).toHaveLength(1);
    expect(signingKid()).toMatch(/^grantex-rs256-/);
    // The auth service still resolves legacy kids itself.
    await expect(verifyGrantToken(await preUpgradeToken('grantex-2026-09'))).resolves.toBeDefined();
  });

  it('signs under the legacy kid for the activation delay after start, then under the thumbprint kid', async () => {
    const ring = await instance('2026-10-01T00:00:00Z', {}, 13, 900);
    expect(signingKid(Date.parse('2026-10-01T00:14:59Z'))).toBe('grantex-2026-10');
    expect(signingKid(Date.parse('2026-10-01T00:15:00Z'))).toBe(ring.active.kid);
  });

  it('only the legacy key signs under a legacy kid', async () => {
    await instance('2026-10-01T00:00:00Z', { alg: 'ES256', ecPrivateKey: ecPem });
    expect(signingKid(Date.parse('2026-10-01T00:00:01Z'))).toMatch(/^grantex-es256-/);
  });

  it('legacy kids are the current month and the months before it', () => {
    expect(legacyKidsForWindow(new Date('2026-02-10T00:00:00Z'), 3)).toEqual(['grantex-2026-02', 'grantex-2026-01', 'grantex-2025-12']);
    expect(legacyKidsForWindow(new Date('2026-02-10T00:00:00Z'), 0)).toEqual([]);
  });
});

describe('env-store rotation keeps outstanding tokens verifiable', () => {
  it('RSA to RSA in the same month: no duplicate kid, and old tokens verify through JWT_LEGACY_KID_KEY', async () => {
    // Before: RSA key 1 signs.
    const before = await instance('2026-09-01T00:00:00Z', {}, 13, 0);
    const oldThumbprintToken = await signGrantToken({ sub: 'u', agt: 'did:grantex:a', dev: 'd', scp: ['read'], jti: 'old', exp: Math.floor(Date.now() / 1000) + 600 });
    const legacyToken = await preUpgradeToken('grantex-2026-09');
    const oldPublic = { ...before.active.publicJwk };

    // Step 1: publish RSA key 2 for verification while key 1 signs.
    const key2Kid = await thumbprintKid('RS256', (await loadEnvSigningKeyRing(env({ rsaPrivateKey: rsaPem2 }))).active.publicJwk);
    const key2Public = { ...(await loadEnvSigningKeyRing(env({ rsaPrivateKey: rsaPem2 }))).active.publicJwk };
    await instance('2026-09-10T00:00:00Z', { verificationPublicKeys: JSON.stringify({ keys: [key2Public] }) }, 13, 0);
    expect(publishedSigningJwks(new Date('2026-09-10T00:00:00Z')).map((key) => key['kid'])).toContain(key2Kid);

    // Step 2: key 2 signs; key 1 stays published and keeps the legacy kids.
    const after = await instance('2026-09-20T00:00:00Z', {
      rsaPrivateKey: rsaPem2,
      verificationPublicKeys: JSON.stringify({ keys: [oldPublic, key2Public] }),
      legacyKidKey: oldPublic.kid,
    }, 13, 0);
    expect(after.active.kid).toBe(key2Kid);
    expect(after.legacyKey?.kid).toBe(oldPublic.kid);
    await expect(verifyGrantToken(oldThumbprintToken)).resolves.toBeDefined();
    await expect(verifyGrantToken(legacyToken)).resolves.toBeDefined();
    await expect(verifyGrantToken(await signGrantToken({ sub: 'u', agt: 'did:grantex:a', dev: 'd', scp: ['read'], jti: 'new', exp: Math.floor(Date.now() / 1000) + 600 }))).resolves.toBeDefined();
    const aliases = publishedSigningJwks(new Date('2026-09-20T00:00:00Z')).filter((key) => LEGACY_KID_RE.test(String(key['kid'])));
    expect(aliases.every((key) => key['n'] === oldPublic.n)).toBe(true);
  });

  it('refuses a JWT_LEGACY_KID_KEY that names no configured key or an EC key', async () => {
    await expect(loadEnvSigningKeyRing(env({ legacyKidKey: 'grantex-rs256-AAAAAAAAAAAAAAAA' }))).rejects.toMatchObject({ code: 'invalid_key' });
    const ecKid = (await loadEnvSigningKeyRing(env({ alg: 'ES256', ecPrivateKey: ecPem, rsaPrivateKey: null }))).active.kid;
    await expect(loadEnvSigningKeyRing(env({ alg: 'ES256', ecPrivateKey: ecPem, rsaPrivateKey: null, legacyKidKey: ecKid })))
      .rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('switching to ES256 with the RSA key still configured keeps legacy tokens verifying', async () => {
    await instance('2026-10-01T00:00:00Z', { alg: 'ES256', ecPrivateKey: ecPem }, 13, 0);
    await expect(verifyGrantToken(await preUpgradeToken('grantex-2026-09'))).resolves.toBeDefined();
    await expect(resolvePlatformVerificationKey({ alg: 'RS256' })).resolves.toBeDefined();
    expect(decodeProtectedHeader(await signGrantToken({ sub: 'u', agt: 'did:grantex:a', dev: 'd', scp: ['read'], jti: 'e', exp: Math.floor(Date.now() / 1000) + 600 })).alg).toBe('ES256');
  });
});

describe('served JWK Set', () => {
  it('buildJwks includes the legacy aliases of the configured RSA key', async () => {
    await initKeys();
    const { keys } = await buildJwks();
    const platform = keys.filter((key) => key['alg'] === 'RS256');
    expect(platform[0]!['kid']).toMatch(/^grantex-rs256-/);
    expect(platform.slice(1).map((key) => key['kid'])).toEqual(legacyKidsForWindow(new Date(), config.jwtLegacyKidMonths));
    expect(new Set(platform.map((key) => key['n'])).size).toBe(1);
    // During the activation delay after start, tokens are signed under this month's legacy kid.
    expect(getKeyPair().kid).toMatch(LEGACY_KID_RE);
  });
});

describe('stored private keys are bound to their kid', () => {
  it('a ciphertext moved to another kid does not decrypt', () => {
    const ciphertext = encryptWithContext('{"d":"secret"}', 'grantex:platform_signing_keys:kid-a');
    expect(decryptWithContext(ciphertext, 'grantex:platform_signing_keys:kid-a')).toBe('{"d":"secret"}');
    expect(() => decryptWithContext(ciphertext, 'grantex:platform_signing_keys:kid-b')).toThrow();
    expect(() => decryptWithContext('AAAA', 'grantex:platform_signing_keys:kid-a')).toThrow('not bound to a context');
  });
});

describe('SSO state key', () => {
  const base = { ssoStateSecret: null, rsaPrivateKey: null, ecPrivateKey: null, vaultEncryptionKey: null };
  const vaultKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('prefers SSO_STATE_SECRET, then the RSA key, then the EC key, then the vault key', () => {
    expect(deriveSsoStateKey({ ...base, ssoStateSecret: 's', rsaPrivateKey: 'r' }, 'production')).toBe('s');
    const fromRsa = deriveSsoStateKey({ ...base, rsaPrivateKey: 'r', ecPrivateKey: 'e' }, 'production');
    expect(fromRsa).toBe(deriveSsoStateKey({ ...base, rsaPrivateKey: 'r' }, 'production'));
    expect(deriveSsoStateKey({ ...base, ecPrivateKey: 'e' }, 'production')).not.toBe(fromRsa);
  });

  it('derives the same key on every instance from VAULT_ENCRYPTION_KEY when no private key is configured', () => {
    const a = deriveSsoStateKey({ ...base, vaultEncryptionKey: vaultKey }, 'production');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSsoStateKey({ ...base, vaultEncryptionKey: vaultKey }, 'production')).toBe(a);
    expect(a).not.toBe(vaultKey);
  });

  it('refuses in production without a persistent secret, and is per-process elsewhere', () => {
    expect(() => deriveSsoStateKey(base, 'production')).toThrow('SSO state needs');
    const dev = deriveSsoStateKey(base, 'development');
    expect(deriveSsoStateKey(base, 'development')).toBe(dev);
  });
});

describe('signing key settings', () => {
  const settings = {
    signingKeyStore: 'postgres' as const,
    vaultEncryptionKey: 'k',
    signingKeyRetiredGraceSeconds: 86_400,
    maxGrantLifetimeSeconds: null as number | null,
    ssoStateSecret: null,
    rsaPrivateKey: null,
    ecPrivateKey: null,
  };

  it('refuses a retired-key grace shorter than the maximum grant lifetime', () => {
    expect(signingKeyConfigErrors({ ...settings, maxGrantLifetimeSeconds: 172_800 }, 'production'))
      .toEqual([expect.stringContaining('SIGNING_KEY_RETIRED_GRACE_SECONDS (86400) must be at least MAX_GRANT_LIFETIME_SECONDS (172800)')]);
    expect(signingKeyConfigErrors({ ...settings, maxGrantLifetimeSeconds: 86_400 }, 'production')).toEqual([]);
    expect(signingKeyConfigErrors({ ...settings, signingKeyStore: 'env', maxGrantLifetimeSeconds: 172_800 }, 'production')).toEqual([]);
  });

  it('warns when the postgres store runs without a maximum grant lifetime', () => {
    expect(signingKeyConfigWarnings(settings)).toEqual([expect.stringContaining('MAX_GRANT_LIFETIME_SECONDS is not set')]);
    expect(signingKeyConfigWarnings({ ...settings, maxGrantLifetimeSeconds: 3_600 })).toEqual([]);
  });

  it('requires VAULT_ENCRYPTION_KEY for the postgres store and a persistent SSO secret in production', () => {
    expect(signingKeyConfigErrors({ ...settings, vaultEncryptionKey: null }, 'production')).toEqual([
      'VAULT_ENCRYPTION_KEY is required when SIGNING_KEY_STORE=postgres',
      expect.stringContaining('SSO_STATE_SECRET is required in production'),
    ]);
    expect(signingKeyConfigErrors({ ...settings, signingKeyStore: 'env', vaultEncryptionKey: null }, 'development')).toEqual([]);
  });

  it('keeps the legacy alias window and activation delay in range', () => {
    expect(config.jwtLegacyKidMonths).toBe(13);
    expect(config.signingKeyActivationDelaySeconds).toBe(900);
  });
});
