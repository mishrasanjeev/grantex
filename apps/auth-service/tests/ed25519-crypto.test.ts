import { describe, it, expect, beforeAll } from 'vitest';
import {
  initKeys, initEdKey, getEdKeyPair, getEdKeyPersistence, getEdKidAliases, buildJwks, signWithEd25519,
} from '../src/lib/crypto.js';
import { jwtVerify, generateKeyPair, exportPKCS8, exportJWK, calculateJwkThumbprint, createLocalJWKSet, SignJWT } from 'jose';
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

  it('signs without exp when expiresInSeconds is null (evidence such as a DPDP consent proof)', async () => {
    const kp = getEdKeyPair()!;
    const jwt = await signWithEd25519({ test: 'evidence' }, { expiresInSeconds: null });

    const { payload, protectedHeader } = await jwtVerify(jwt, kp.publicKey, { algorithms: ['EdDSA'] });

    expect(payload.exp).toBeUndefined();
    expect(payload.iat).toBeDefined();
    expect(protectedHeader.kid).toBe(kp.kid);
  });
});

describe('initEdKey with PEM import', () => {
  it('initializes Ed25519 key pair from a PKCS8 PEM private key', async () => {
    // Generate a fresh Ed25519 key pair and export the private key as PEM
    const { privateKey: generatedPrivate } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });
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
      expect(getEdKeyPersistence()).toBe('persistent');
    } finally {
      // Reset config so other tests are not affected
      (config as { ed25519PrivateKey: string | null }).ed25519PrivateKey = null;
      // Re-initialize with auto-generated key
      await initEdKey();
    }
    expect(getEdKeyPersistence()).toBe('ephemeral');
  });
});

describe('ED25519_STABLE_KID', () => {
  const settable = config as { ed25519PrivateKey: string | null; ed25519StableKid: boolean; jwtLegacyKidMonths: number };

  async function withKey(stableKid: boolean, fn: (pem: string) => Promise<void>): Promise<void> {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const pem = await exportPKCS8(privateKey);
    settable.ed25519PrivateKey = pem;
    settable.ed25519StableKid = stableKid;
    try {
      await initEdKey();
      await fn(pem);
    } finally {
      settable.ed25519PrivateKey = null;
      settable.ed25519StableKid = false;
      await initEdKey();
    }
  }

  function monthKid(monthsBack: number): string {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
    return `grantex-ed25519-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  it('gives a configured key a kid derived from its RFC 7638 thumbprint, the same on every start', async () => {
    await withKey(true, async () => {
      const kp = getEdKeyPair()!;
      const jwk = await exportJWK(kp.publicKey);
      const thumbprint = await calculateJwkThumbprint({ kty: 'OKP', crv: jwk.crv!, x: jwk.x! }, 'sha256');
      expect(kp.kid).toBe(`grantex-ed25519-${thumbprint}`);
      await initEdKey();
      expect(getEdKeyPair()!.kid).toBe(kp.kid);
      expect(getEdKeyPersistence()).toBe('persistent');
    });
  });

  it('publishes the key under its stable kid and the month kids of the last JWT_LEGACY_KID_MONTHS months', async () => {
    await withKey(true, async () => {
      const kp = getEdKeyPair()!;
      const jwks = await buildJwks();
      const edKeys = jwks.keys.filter((k) => k['alg'] === 'EdDSA');
      const kids = edKeys.map((k) => k['kid']);
      expect(kids[0]).toBe(kp.kid);
      expect(kids).toContain(monthKid(0));
      expect(kids).toContain(monthKid(config.jwtLegacyKidMonths));
      expect(kids).not.toContain(monthKid(config.jwtLegacyKidMonths + 1));
      expect(edKeys).toHaveLength(config.jwtLegacyKidMonths + 2);
      expect(new Set(edKeys.map((k) => k['x'])).size).toBe(1);
      expect(edKeys.every((k) => k['d'] === undefined)).toBe(true);
      expect(getEdKidAliases()).toEqual(kids.slice(1));
    });
  });

  it('verifies against the JWKS a proof signed now and one signed under an earlier month kid', async () => {
    await withKey(true, async () => {
      const kp = getEdKeyPair()!;
      const jwks = createLocalJWKSet(await buildJwks() as Parameters<typeof createLocalJWKSet>[0]);

      const now = await signWithEd25519({ proof: 'now' }, { expiresInSeconds: null });
      const verifiedNow = await jwtVerify(now, jwks, { algorithms: ['EdDSA'] });
      expect(verifiedNow.protectedHeader.kid).toBe(kp.kid);

      // A proof the same key signed last month, before the flag was turned on.
      const earlier = await new SignJWT({ proof: 'earlier' })
        .setProtectedHeader({ alg: 'EdDSA', kid: monthKid(1) })
        .setIssuedAt()
        .sign(kp.privateKey);
      const verifiedEarlier = await jwtVerify(earlier, jwks, { algorithms: ['EdDSA'] });
      expect(verifiedEarlier.payload['proof']).toBe('earlier');
    });
  });

  it('honours JWT_LEGACY_KID_MONTHS=0 by publishing only this month as an alias', async () => {
    const months = config.jwtLegacyKidMonths;
    settable.jwtLegacyKidMonths = 0;
    try {
      await withKey(true, async () => {
        expect(getEdKidAliases()).toEqual([monthKid(0)]);
      });
    } finally {
      settable.jwtLegacyKidMonths = months;
    }
  });

  it('leaves a configured key on the month kid, with no aliases, when the flag is off', async () => {
    await withKey(false, async () => {
      expect(getEdKeyPair()!.kid).toBe(monthKid(0));
      expect(getEdKidAliases()).toEqual([]);
      const edKeys = (await buildJwks()).keys.filter((k) => k['alg'] === 'EdDSA');
      expect(edKeys.map((k) => k['kid'])).toEqual([monthKid(0)]);
    });
  });

  it('keeps a generated (ephemeral) key on the month kid even with the flag on', async () => {
    settable.ed25519StableKid = true;
    try {
      await initEdKey();
      expect(getEdKeyPersistence()).toBe('ephemeral');
      expect(getEdKeyPair()!.kid).toBe(monthKid(0));
      expect(getEdKidAliases()).toEqual([]);
    } finally {
      settable.ed25519StableKid = false;
      await initEdKey();
    }
  });
});
