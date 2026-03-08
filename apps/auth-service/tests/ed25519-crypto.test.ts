import { describe, it, expect, beforeAll } from 'vitest';
import {
  initKeys, initEdKey, getEdKeyPair, buildJwks, signWithEd25519,
} from '../src/lib/crypto.js';
import { jwtVerify, generateKeyPair, exportPKCS8 } from 'jose';
import { config } from '../src/config.js';

beforeAll(async () => {
  process.env['AUTO_GENERATE_KEYS'] = 'true';
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  await initKeys();
  await initEdKey();
});

describe('initEdKey / getEdKeyPair', () => {
  it('generates an Ed25519 key pair when no config key is set', () => {
    const kp = getEdKeyPair();
    expect(kp).not.toBeNull();
    expect(kp!.privateKey).toBeDefined();
    expect(kp!.publicKey).toBeDefined();
    expect(kp!.kid).toMatch(/^grantex-ed25519-\d{4}-\d{2}$/);
  });

  it('returns the key pair after init', () => {
    const kp = getEdKeyPair();
    expect(kp).not.toBeNull();
    expect(kp!.privateKey).toBeDefined();
    expect(kp!.publicKey).toBeDefined();
  });
});

describe('buildJwks with Ed25519', () => {
  it('includes both RSA and Ed25519 keys', async () => {
    const jwks = await buildJwks();
    expect(jwks.keys.length).toBeGreaterThanOrEqual(2);

    const rsaKey = jwks.keys.find((k) => k['alg'] === 'RS256');
    expect(rsaKey).toBeDefined();
    expect(rsaKey!['kty']).toBe('RSA');
    expect(rsaKey!['use']).toBe('sig');

    const edKey = jwks.keys.find((k) => k['alg'] === 'EdDSA');
    expect(edKey).toBeDefined();
    expect(edKey!['kty']).toBe('OKP');
    expect(edKey!['crv']).toBe('Ed25519');
    expect(edKey!['use']).toBe('sig');
    expect(edKey!['kid']).toMatch(/^grantex-ed25519-\d{4}-\d{2}$/);
  });

  it('does not expose Ed25519 private key components', async () => {
    const jwks = await buildJwks();
    const edKey = jwks.keys.find((k) => k['alg'] === 'EdDSA');
    expect(edKey).toBeDefined();
    expect(edKey!['d']).toBeUndefined();
  });
});

describe('signWithEd25519', () => {
  it('produces a valid JWT signed with EdDSA', async () => {
    const jwt = await signWithEd25519({ foo: 'bar', purpose: 'test' });
    expect(typeof jwt).toBe('string');
    expect(jwt.split('.')).toHaveLength(3);

    // Verify the header uses EdDSA algorithm
    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString());
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toMatch(/^grantex-ed25519-\d{4}-\d{2}$/);
  });

  it('can be verified with the Ed25519 public key', async () => {
    const kp = getEdKeyPair()!;
    const jwt = await signWithEd25519({ test: 'value' });

    const { payload } = await jwtVerify(jwt, kp.publicKey, {
      algorithms: ['EdDSA'],
    });

    expect(payload['test']).toBe('value');
    expect(payload.iss).toBe('https://grantex.dev');
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });
});

describe('initEdKey with PEM import', () => {
  it('initializes Ed25519 key pair from a PKCS8 PEM private key', async () => {
    // Generate a fresh Ed25519 key pair and export the private key as PEM
    const { privateKey: generatedPrivate } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const pem = await exportPKCS8(generatedPrivate);

    // Set the config to use the PEM import path
    (config as { ed25519PrivateKey: string | null }).ed25519PrivateKey = pem;

    try {
      // Re-initialize — this should take the PEM import branch (lines 148-162)
      await initEdKey();

      const kp = getEdKeyPair();
      expect(kp).not.toBeNull();
      expect(kp!.privateKey).toBeDefined();
      expect(kp!.publicKey).toBeDefined();
      expect(kp!.kid).toMatch(/^grantex-ed25519-\d{4}-\d{2}$/);

      // Verify the imported key can sign and verify a JWT
      const jwt = await signWithEd25519({ pemTest: true });
      const { payload } = await jwtVerify(jwt, kp!.publicKey, {
        algorithms: ['EdDSA'],
      });
      expect(payload['pemTest']).toBe(true);
    } finally {
      // Reset config so other tests are not affected
      (config as { ed25519PrivateKey: string | null }).ed25519PrivateKey = null;
      // Re-initialize with auto-generated key
      await initEdKey();
    }
  });
});
