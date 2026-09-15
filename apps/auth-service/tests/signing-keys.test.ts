import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SignJWT,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  jwtVerify,
  createLocalJWKSet,
} from 'jose';
import { config } from '../src/config.js';
import {
  buildJwks,
  getKeyPair,
  initKeys,
  signGrantToken,
  signOAuthAccessToken,
  verifyGrantToken,
  verifyOAuthAccessToken,
  verifyPrincipalSessionToken,
  signPrincipalSessionToken,
} from '../src/lib/crypto.js';
import {
  SigningKeyError,
  SigningKeyRing,
  loadEnvSigningKeyRing,
  parseRetiredPublicKeys,
  resolvePlatformVerificationKey,
  setSigningKeyRing,
  UNKNOWN_KID_RELOAD_COOLDOWN_MS,
  getSigningKeyRing,
} from '../src/lib/signing-keys.js';
import { buildTestApp, sqlMock } from './helpers.js';
import { encrypt } from '../src/lib/vault-crypto.js';
import { stopKeyReload } from '../src/lib/crypto.js';
import { parseRotateArgs } from '../src/cli/rotate-signing-key.js';

type MutableConfig = {
  signingKeyStore: 'env' | 'postgres';
  jwtSigningAlg: 'RS256' | 'ES256';
  rsaPrivateKey: string | null;
  ecPrivateKey: string | null;
  autoGenerateKeys: boolean;
  jwtSigningKid: string | null;
  jwtRetiredPublicKeys: string | null;
};
const mutable = config as unknown as MutableConfig;
const original: MutableConfig = {
  signingKeyStore: config.signingKeyStore,
  jwtSigningAlg: config.jwtSigningAlg,
  rsaPrivateKey: config.rsaPrivateKey,
  ecPrivateKey: config.ecPrivateKey,
  autoGenerateKeys: config.autoGenerateKeys,
  jwtSigningKid: config.jwtSigningKid,
  jwtRetiredPublicKeys: config.jwtRetiredPublicKeys,
};

let rsaPem: string;
let ecPem: string;
let p384Pem: string;

beforeAll(async () => {
  rsaPem = await exportPKCS8((await generateKeyPair('RS256', { modulusLength: 2048, extractable: true })).privateKey);
  ecPem = await exportPKCS8((await generateKeyPair('ES256', { extractable: true })).privateKey);
  p384Pem = await exportPKCS8((await generateKeyPair('ES384', { extractable: true })).privateKey);
});

afterEach(async () => {
  Object.assign(mutable, original);
  await initKeys();
});

async function useKeys(settings: Partial<MutableConfig>): Promise<void> {
  Object.assign(mutable, original, { autoGenerateKeys: false }, settings);
  await initKeys();
}

const exp = () => Math.floor(Date.now() / 1000) + 3600;

async function grantToken(): Promise<string> {
  return signGrantToken({
    sub: 'user_es', agt: 'did:grantex:ag_es', dev: 'dev_es', scp: ['read'], jti: 'tok_es', grnt: 'grnt_es', exp: exp(),
  });
}

function reencodeHeader(token: string, header: Record<string, unknown>): string {
  const [, payload, signature] = token.split('.');
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payload}.${signature}`;
}

describe('ES256 signing key', () => {
  it('signs grant tokens with ES256 when JWT_SIGNING_ALG=ES256 and EC_PRIVATE_KEY is set', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem });

    const token = await grantToken();
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('ES256');
    expect(header.kid).toMatch(/^grantex-es256-[A-Za-z0-9_-]{16}$/);
    expect(header.kid).toBe(getKeyPair().kid);
    await expect(verifyGrantToken(token)).resolves.toMatchObject({ sub: 'user_es', grnt: 'grnt_es' });
  });

  it('publishes the EC key in the JWK Set with kid, alg and use and no private members', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem });

    const { keys } = await buildJwks();
    const ec = keys.find((key) => key['kid'] === getKeyPair().kid)!;
    expect(ec).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
    expect(typeof ec['x']).toBe('string');
    expect(typeof ec['y']).toBe('string');
    expect(ec['d']).toBeUndefined();
  });

  it('serves the ES256 key from /.well-known/jwks.json and a stock JOSE verifier accepts the token', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem });
    const app = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    const jwks = createLocalJWKSet(res.json());

    const token = await grantToken();
    const { protectedHeader } = await jwtVerify(token, jwks, { algorithms: ['ES256'], issuer: config.jwtIssuer });
    expect(protectedHeader.alg).toBe('ES256');
  });

  it('auto-generates an ES256 key when AUTO_GENERATE_KEYS=true', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', autoGenerateKeys: true });
    expect(getKeyPair().alg).toBe('ES256');
    await expect(verifyGrantToken(await grantToken())).resolves.toBeDefined();
  });

  it('signs OAuth access tokens and principal session tokens with the configured algorithm', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem });

    const access = await signOAuthAccessToken({
      sub: 'user_es', clientId: 'ag_es', scopes: ['read'], jti: 'tok_oauth', aud: 'https://rs.example.com',
      cnf: { jkt: 'thumb' }, exp: exp(),
    });
    expect(decodeProtectedHeader(access).alg).toBe('ES256');
    await expect(verifyOAuthAccessToken(access)).resolves.toMatchObject({ clientId: 'ag_es' });

    const session = await signPrincipalSessionToken({ principalId: 'user_es', developerId: 'dev_es' }, 600);
    expect(decodeProtectedHeader(session).alg).toBe('ES256');
    await expect(verifyPrincipalSessionToken(session)).resolves.toEqual({ principalId: 'user_es', developerId: 'dev_es' });
  });

  it('keeps RS256 as the default algorithm', () => {
    expect(config.jwtSigningAlg).toBe('RS256');
    expect(getKeyPair().alg).toBe('RS256');
  });

  it('refuses to start without a key for the configured algorithm', async () => {
    Object.assign(mutable, { jwtSigningAlg: 'ES256', ecPrivateKey: null, rsaPrivateKey: rsaPem, autoGenerateKeys: false });
    await expect(initKeys()).rejects.toThrow('No EC P-256 key configured for JWT_SIGNING_ALG=ES256');
  });

  it('rejects an EC_PRIVATE_KEY that is an RSA key or not on P-256', async () => {
    await expect(loadEnvSigningKeyRing({
      alg: 'ES256', rsaPrivateKey: null, ecPrivateKey: rsaPem, autoGenerate: false, kid: null, retiredPublicKeys: null,
    })).rejects.toMatchObject({ code: 'invalid_key' });
    await expect(loadEnvSigningKeyRing({
      alg: 'ES256', rsaPrivateKey: null, ecPrivateKey: p384Pem, autoGenerate: false, kid: null, retiredPublicKeys: null,
    })).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('rejects an RSA_PRIVATE_KEY that is an EC key', async () => {
    await expect(loadEnvSigningKeyRing({
      alg: 'RS256', rsaPrivateKey: ecPem, ecPrivateKey: null, autoGenerate: false, kid: null, retiredPublicKeys: null,
    })).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('honours JWT_SIGNING_KID', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem, jwtSigningKid: 'grantex-prod-2026-09' });
    expect(decodeProtectedHeader(await grantToken()).kid).toBe('grantex-prod-2026-09');
  });
});

describe('rotation keeps old keys for verification', () => {
  it('publishes a configured key for the other algorithm for verification only', async () => {
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });

    const ring = getSigningKeyRing();
    expect(ring.active.alg).toBe('RS256');
    const ec = ring.keys().find((key) => key.alg === 'ES256')!;
    expect(ec.privateKey).toBeNull();
    expect(ec.status).toBe('retired');
    const { keys } = await buildJwks();
    expect(keys.map((key) => key['alg'])).toEqual(expect.arrayContaining(['RS256', 'ES256']));
  });

  it('verifies tokens signed by the previous RS256 key after switching to ES256', async () => {
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem });
    const before = await grantToken();

    // Step 1: switch algorithm while the RSA key is still configured.
    await useKeys({ jwtSigningAlg: 'ES256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });
    await expect(verifyGrantToken(before)).resolves.toMatchObject({ sub: 'user_es' });
    const after = await grantToken();
    expect(decodeProtectedHeader(after).alg).toBe('ES256');

    // Step 2: remove the RSA private key and keep only its public key.
    const rsaPublic = (await buildJwks()).keys.find((key) => key['alg'] === 'RS256')!;
    await useKeys({
      jwtSigningAlg: 'ES256', ecPrivateKey: ecPem, jwtRetiredPublicKeys: JSON.stringify({ keys: [rsaPublic] }),
    });
    await expect(verifyGrantToken(before)).resolves.toMatchObject({ sub: 'user_es' });
    await expect(verifyGrantToken(after)).resolves.toMatchObject({ sub: 'user_es' });
  });

  it('rejects a retired key set with a duplicate kid, private members, HS256 or a key-type mismatch', async () => {
    const ecJwk = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).publicKey)), kid: 'old', alg: 'ES256' };
    const rsaPair = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const rsaJwk = { ...(await exportJWK(rsaPair.publicKey)), kid: 'old-rsa', alg: 'RS256' };

    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [ecJwk, ecJwk] })).then((keys) =>
      new SigningKeyRing({ ...keys[0]!, privateKey: getKeyPair().privateKey, status: 'active' }, keys.slice(1))))
      .rejects.toMatchObject({ code: 'duplicate_kid' });
    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [{ ...(await exportJWK(rsaPair.privateKey)), kid: 'x', alg: 'RS256' }] })))
      .rejects.toMatchObject({ code: 'invalid_key' });
    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [{ kty: 'oct', k: 'c2VjcmV0', kid: 'h', alg: 'HS256' }] })))
      .rejects.toMatchObject({ code: 'unsupported_alg' });
    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [{ ...rsaJwk, alg: 'ES256' }] })))
      .rejects.toMatchObject({ code: 'alg_key_mismatch' });
    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [{ ...ecJwk, alg: 'none' }] })))
      .rejects.toMatchObject({ code: 'unsupported_alg' });
    await expect(parseRetiredPublicKeys('not json')).rejects.toBeInstanceOf(SigningKeyError);
    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [rsaJwk] }))).resolves.toHaveLength(1);
  });

  it('rejects an RSA key shorter than 2048 bits', async () => {
    // A 1024-bit modulus, built as bytes: the size check runs before import.
    const jwk = { kty: 'RSA', n: randomBytes(128).toString('base64url'), e: 'AQAB', kid: 'weak', alg: 'RS256' };
    await expect(parseRetiredPublicKeys(JSON.stringify({ keys: [jwk] }))).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('reloads the key set once when a token names an unknown kid, then fails closed', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem });
    const current = getSigningKeyRing();
    const other = await loadEnvSigningKeyRing({
      alg: 'ES256', rsaPrivateKey: null, ecPrivateKey: null, autoGenerate: true, kid: 'rotated-in', retiredPublicKeys: null,
    });
    let reloads = 0;
    setSigningKeyRing(current, async () => {
      reloads += 1;
      return new SigningKeyRing(current.active, [{ ...other.active, privateKey: null, status: 'retired' }]);
    });
    const header = { alg: 'ES256', kid: 'rotated-in' };

    // Inside the cooldown there is no reload.
    await expect(resolvePlatformVerificationKey(header)).rejects.toMatchObject({ code: 'unknown_kid' });
    expect(reloads).toBe(0);

    const realNow = Date.now;
    Date.now = () => realNow() + UNKNOWN_KID_RELOAD_COOLDOWN_MS + 1;
    try {
      await expect(resolvePlatformVerificationKey(header)).resolves.toBeDefined();
      expect(reloads).toBe(1);
      await expect(resolvePlatformVerificationKey({ alg: 'ES256', kid: 'never-published' }))
        .rejects.toMatchObject({ code: 'unknown_kid' });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('algorithm and key confusion', () => {
  it('rejects an ES256 token whose kid names the RSA key', async () => {
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });
    const rsaKid = getKeyPair().kid;
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ agt: 'did:grantex:ag', dev: 'dev', scp: ['read'] })
      .setProtectedHeader({ alg: 'ES256', kid: rsaKid })
      .setIssuer(config.jwtIssuer).setSubject('user').setJti('tok').setIssuedAt().setExpirationTime(exp())
      .sign(privateKey);
    await expect(verifyGrantToken(forged)).rejects.toMatchObject({ code: 'alg_key_mismatch' });
  });

  it('rejects an RS256 token whose kid names the EC key', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });
    const ecKid = getKeyPair().kid;
    const token = await grantToken();
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });
    const rsaSigned = await grantToken();
    const tampered = reencodeHeader(rsaSigned, { alg: 'RS256', kid: ecKid, typ: 'at+jwt' });
    await expect(verifyGrantToken(tampered)).rejects.toMatchObject({ code: 'alg_key_mismatch' });
    await expect(verifyGrantToken(token)).resolves.toBeDefined();
  });

  it('rejects an RS256 token whose alg header was changed to ES256', async () => {
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });
    const token = await grantToken();
    const header = decodeProtectedHeader(token);
    await expect(verifyGrantToken(reencodeHeader(token, { ...header, alg: 'ES256' })))
      .rejects.toMatchObject({ code: 'alg_key_mismatch' });

    const ecKid = getSigningKeyRing().keys().find((key) => key.alg === 'ES256')!.kid;
    await expect(verifyGrantToken(reencodeHeader(token, { ...header, alg: 'ES256', kid: ecKid }))).rejects.toThrow();
  });

  it('rejects an ES256 token whose alg header was changed to RS256', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem, rsaPrivateKey: rsaPem });
    const token = await grantToken();
    await expect(verifyGrantToken(reencodeHeader(token, { ...decodeProtectedHeader(token), alg: 'RS256' })))
      .rejects.toMatchObject({ code: 'alg_key_mismatch' });
  });

  it('rejects HS256 tokens keyed with the published public key', async () => {
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem });
    const { kid, publicKey } = getKeyPair();
    const secret = new TextEncoder().encode(await exportSPKI(publicKey));
    const forged = await new SignJWT({ agt: 'did:grantex:ag', dev: 'dev', scp: ['admin'] })
      .setProtectedHeader({ alg: 'HS256', kid })
      .setIssuer(config.jwtIssuer).setSubject('user').setJti('tok').setIssuedAt().setExpirationTime(exp())
      .sign(secret);
    await expect(verifyGrantToken(forged)).rejects.toThrow(/alg/i);
    await expect(resolvePlatformVerificationKey({ alg: 'HS256', kid })).rejects.toMatchObject({ code: 'unsupported_alg' });
  });

  it('rejects alg none', async () => {
    const { kid } = getKeyPair();
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: config.jwtIssuer, sub: 'user', agt: 'did:grantex:ag', dev: 'dev', scp: ['admin'], jti: 'tok',
      iat: Math.floor(Date.now() / 1000), exp: exp(),
    })).toString('base64url');
    await expect(verifyGrantToken(`${header}.${payload}.`)).rejects.toThrow();
    await expect(resolvePlatformVerificationKey({ alg: 'none', kid })).rejects.toMatchObject({ code: 'unsupported_alg' });
  });

  it('rejects a token without kid unless its alg is the active key algorithm', async () => {
    await useKeys({ jwtSigningAlg: 'RS256', rsaPrivateKey: rsaPem, ecPrivateKey: ecPem });
    await expect(resolvePlatformVerificationKey({ alg: 'RS256' })).resolves.toBe(getKeyPair().publicKey);
    await expect(resolvePlatformVerificationKey({ alg: 'ES256' })).rejects.toMatchObject({ code: 'missing_kid' });
  });

  it('rejects a token signed by a foreign EC key under an unknown kid without falling back', async () => {
    await useKeys({ jwtSigningAlg: 'ES256', ecPrivateKey: ecPem });
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ agt: 'did:grantex:ag', dev: 'dev', scp: ['read'] })
      .setProtectedHeader({ alg: 'ES256', kid: 'foreign' })
      .setIssuer(config.jwtIssuer).setSubject('user').setJti('tok').setIssuedAt().setExpirationTime(exp())
      .sign(privateKey);
    await expect(verifyGrantToken(forged)).rejects.toMatchObject({ code: 'unknown_kid' });
  });
});

describe('postgres key store start-up', () => {
  it('signs with the stored active key and reloads on a timer', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const publicJwk = { ...(await exportJWK(publicKey)), kid: 'grantex-es256-stored', alg: 'ES256', use: 'sig' };
    sqlMock.mockResolvedValueOnce([{
      kid: 'grantex-es256-stored',
      algorithm: 'ES256',
      public_key_jwk: publicJwk,
      encrypted_private_key_jwk: encrypt(JSON.stringify(await exportJWK(privateKey))),
      status: 'active',
    }]);
    Object.assign(mutable, { signingKeyStore: 'postgres', jwtSigningAlg: 'RS256' });
    try {
      await initKeys();
      expect(getKeyPair()).toMatchObject({ kid: 'grantex-es256-stored', alg: 'ES256' });
      expect(decodeProtectedHeader(await grantToken())).toMatchObject({ alg: 'ES256', kid: 'grantex-es256-stored' });
    } finally {
      stopKeyReload();
    }
  });

  it('refuses a stored active key whose public key does not match its private key', async () => {
    const stored = await generateKeyPair('ES256', { extractable: true });
    const other = await generateKeyPair('ES256', { extractable: true });
    sqlMock.mockResolvedValueOnce([{
      kid: 'grantex-es256-mismatch',
      algorithm: 'ES256',
      public_key_jwk: { ...(await exportJWK(other.publicKey)), kid: 'grantex-es256-mismatch', alg: 'ES256', use: 'sig' },
      encrypted_private_key_jwk: encrypt(JSON.stringify(await exportJWK(stored.privateKey))),
      status: 'active',
    }]);
    Object.assign(mutable, { signingKeyStore: 'postgres' });
    await expect(initKeys()).rejects.toMatchObject({ code: 'invalid_key' });
  });
});

describe('rotate-signing-key arguments', () => {
  it('defaults to the configured algorithm and accepts only RS256 or ES256', () => {
    expect(parseRotateArgs([], 'RS256')).toEqual({ alg: 'RS256' });
    expect(parseRotateArgs(['--alg', 'ES256'], 'RS256')).toEqual({ alg: 'ES256' });
    expect(() => parseRotateArgs(['--alg', 'HS256'], 'RS256')).toThrow('--alg must be one of: RS256, ES256');
    expect(() => parseRotateArgs(['--alg'], 'RS256')).toThrow('--alg needs a value');
    expect(() => parseRotateArgs(['--force'], 'RS256')).toThrow('Unknown argument');
  });
});

describe('signing algorithm settings', () => {
  it('accepts only RS256 and ES256 for JWT_SIGNING_ALG and env or postgres for SIGNING_KEY_STORE', async () => {
    const { parseSigningAlgorithm, parseSigningKeyStore } = await import('../src/lib/signing-algorithms.js');
    expect(parseSigningAlgorithm('JWT_SIGNING_ALG', 'ES256')).toBe('ES256');
    for (const value of ['none', 'HS256', 'PS256', 'EdDSA', 'es256', '']) {
      expect(() => parseSigningAlgorithm('JWT_SIGNING_ALG', value)).toThrow('JWT_SIGNING_ALG must be one of: RS256, ES256');
    }
    expect(parseSigningKeyStore('SIGNING_KEY_STORE', 'postgres')).toBe('postgres');
    expect(() => parseSigningKeyStore('SIGNING_KEY_STORE', 'file')).toThrow('SIGNING_KEY_STORE must be one of: env, postgres');
  });
});
