import { describe, it, expect, beforeAll } from 'vitest';
import {
  initKeys, getKeyPair, signGrantToken, verifyGrantToken, buildJwks,
  decodeTokenClaims, parseExpiresIn,
  signPrincipalSessionToken, verifyPrincipalSessionToken,
} from '../src/lib/crypto.js';
import { decodeJwt, generateKeyPair, exportPKCS8 } from 'jose';

beforeAll(async () => {
  process.env['AUTO_GENERATE_KEYS'] = 'true';
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  await initKeys();
});

describe('initKeys / getKeyPair', () => {
  it('generates a key pair', () => {
    const kp = getKeyPair();
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey).toBeDefined();
    expect(kp.kid).toMatch(/^grantex-\d{4}-\d{2}$/);
  });
});

describe('initKeys with RSA_PRIVATE_KEY', () => {
  it('imports an RSA private key from PEM', async () => {
    const { config } = await import('../src/config.js');
    const originalRsa = config.rsaPrivateKey;
    const originalAuto = config.autoGenerateKeys;

    // Generate an RSA key and export as PKCS8 PEM
    const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
    const pem = await exportPKCS8(privateKey);

    // Temporarily set config to use RSA PEM path
    (config as { rsaPrivateKey: string | null }).rsaPrivateKey = pem;
    (config as { autoGenerateKeys: boolean }).autoGenerateKeys = false;

    await initKeys();

    const kp = getKeyPair();
    expect(kp.privateKey).toBeDefined();
    expect(kp.publicKey).toBeDefined();
    expect(kp.kid).toMatch(/^grantex-\d{4}-\d{2}$/);

    // Verify the imported key works for signing
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_rsa', agt: 'did:grantex:ag_rsa', dev: 'dev_rsa',
      scp: ['read'], jti: 'tok_rsa', exp,
    });
    const result = await verifyGrantToken(jwt);
    expect(result.sub).toBe('user_rsa');

    // Restore config and re-init with auto-generate
    (config as { rsaPrivateKey: string | null }).rsaPrivateKey = originalRsa;
    (config as { autoGenerateKeys: boolean }).autoGenerateKeys = originalAuto;
    await initKeys();
  });

  it('throws when neither RSA key nor auto-generate is configured', async () => {
    const { config } = await import('../src/config.js');
    const originalRsa = config.rsaPrivateKey;
    const originalAuto = config.autoGenerateKeys;

    (config as { rsaPrivateKey: string | null }).rsaPrivateKey = null;
    (config as { autoGenerateKeys: boolean }).autoGenerateKeys = false;

    await expect(initKeys()).rejects.toThrow('No RSA key configured');

    // Restore
    (config as { rsaPrivateKey: string | null }).rsaPrivateKey = originalRsa;
    (config as { autoGenerateKeys: boolean }).autoGenerateKeys = originalAuto;
    await initKeys();
  });
});

describe('buildJwks', () => {
  it('returns a JWKS with one RSA key', async () => {
    const jwks = await buildJwks();
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0]!;
    expect(key['kty']).toBe('RSA');
    expect(key['alg']).toBe('RS256');
    expect(key['use']).toBe('sig');
    expect(key['n']).toBeDefined();
    expect(key['e']).toBeDefined();
    expect(key['kid']).toBeDefined();
  });

  it('does not expose private key components', async () => {
    const jwks = await buildJwks();
    const key = jwks.keys[0]!;
    expect(key['d']).toBeUndefined();
    expect(key['p']).toBeUndefined();
    expect(key['q']).toBeUndefined();
  });
});

describe('signGrantToken / decodeTokenClaims', () => {
  it('signs a JWT with RS256 and correct claims', async () => {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;
    const jwt = await signGrantToken({
      sub: 'user_123',
      agt: 'did:grantex:ag_001',
      dev: 'dev_001',
      scp: ['read', 'write'],
      jti: 'tok_001',
      grnt: 'grnt_001',
      exp,
    });

    expect(typeof jwt).toBe('string');
    expect(jwt.split('.')).toHaveLength(3);

    const header = JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString());
    expect(header.alg).toBe('RS256');

    const claims = decodeJwt(jwt);
    expect(claims.sub).toBe('user_123');
    expect(claims['agt']).toBe('did:grantex:ag_001');
    expect(claims['dev']).toBe('dev_001');
    expect(claims['scp']).toEqual(['read', 'write']);
    expect(claims.jti).toBe('tok_001');
    expect(claims['grnt']).toBe('grnt_001');
    expect(claims.exp).toBe(exp);
  });

  it('round-trips through decodeTokenClaims', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_abc',
      agt: 'did:grantex:ag_abc',
      dev: 'dev_abc',
      scp: ['read'],
      jti: 'tok_abc',
      exp,
    });

    const claims = decodeTokenClaims(jwt);
    expect(claims['sub']).toBe('user_abc');
    expect(claims['jti']).toBe('tok_abc');
  });

  it('omits grnt when not provided', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_x',
      agt: 'did:grantex:ag_x',
      dev: 'dev_x',
      scp: [],
      jti: 'tok_x',
      exp,
    });
    const claims = decodeJwt(jwt);
    expect(claims['grnt']).toBeUndefined();
  });
});

describe('signGrantToken with audience', () => {
  it('includes aud claim when audience is provided', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_aud',
      agt: 'did:grantex:ag_aud',
      dev: 'dev_aud',
      scp: ['read'],
      jti: 'tok_aud',
      grnt: 'grnt_aud',
      aud: 'https://api.example.com',
      exp,
    });

    const claims = decodeJwt(jwt);
    expect(claims.aud).toBe('https://api.example.com');
  });

  it('includes delegation claims when provided', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_dlg',
      agt: 'did:grantex:ag_child',
      dev: 'dev_dlg',
      scp: ['read'],
      jti: 'tok_dlg',
      grnt: 'grnt_dlg',
      parentAgt: 'did:grantex:ag_parent',
      parentGrnt: 'grnt_parent',
      delegationDepth: 1,
      exp,
    });

    const claims = decodeJwt(jwt);
    expect(claims['parentAgt']).toBe('did:grantex:ag_parent');
    expect(claims['parentGrnt']).toBe('grnt_parent');
    expect(claims['delegationDepth']).toBe(1);
  });

  it('includes bdg claim when budget is provided', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_bdg',
      agt: 'did:grantex:ag_bdg',
      dev: 'dev_bdg',
      scp: ['read'],
      jti: 'tok_bdg',
      grnt: 'grnt_bdg',
      bdg: 42.5,
      exp,
    });

    const claims = decodeJwt(jwt);
    expect(claims['bdg']).toBe(42.5);
  });
});

describe('verifyGrantToken', () => {
  it('verifies a valid grant token and returns claims', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_verify',
      agt: 'did:grantex:ag_verify',
      dev: 'dev_verify',
      scp: ['read', 'write'],
      jti: 'tok_verify',
      exp,
    });

    const result = await verifyGrantToken(jwt);
    expect(result.sub).toBe('user_verify');
    expect(result.dev).toBe('dev_verify');
    expect(result.scp).toEqual(['read', 'write']);
  });

  it('throws for an expired token', async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600; // expired 1 hour ago
    const jwt = await signGrantToken({
      sub: 'user_exp',
      agt: 'did:grantex:ag_exp',
      dev: 'dev_exp',
      scp: ['read'],
      jti: 'tok_exp',
      exp,
    });

    await expect(verifyGrantToken(jwt)).rejects.toThrow();
  });

  it('throws for a tampered token', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signGrantToken({
      sub: 'user_tamper',
      agt: 'did:grantex:ag_tamper',
      dev: 'dev_tamper',
      scp: ['read'],
      jti: 'tok_tamper',
      exp,
    });

    // Tamper with the payload
    const parts = jwt.split('.');
    const tampered = parts[0] + '.' + parts[1]!.slice(0, -2) + 'XX' + '.' + parts[2];
    await expect(verifyGrantToken(tampered)).rejects.toThrow();
  });
});

describe('signPrincipalSessionToken / verifyPrincipalSessionToken', () => {
  it('signs and verifies a principal session token', async () => {
    const token = await signPrincipalSessionToken(
      { principalId: 'user_session', developerId: 'dev_session' },
      3600,
    );

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const result = await verifyPrincipalSessionToken(token);
    expect(result.principalId).toBe('user_session');
    expect(result.developerId).toBe('dev_session');
  });

  it('includes purpose claim in token', async () => {
    const token = await signPrincipalSessionToken(
      { principalId: 'user_p', developerId: 'dev_p' },
      3600,
    );

    const claims = decodeJwt(token);
    expect(claims['purpose']).toBe('principal_dashboard');
    expect(claims.sub).toBe('user_p');
    expect(claims['dev']).toBe('dev_p');
  });

  it('throws for token with wrong purpose', async () => {
    // Sign a grant token (purpose is not principal_dashboard)
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const grantJwt = await signGrantToken({
      sub: 'user_wrong',
      agt: 'did:grantex:ag_wrong',
      dev: 'dev_wrong',
      scp: ['read'],
      jti: 'tok_wrong_purpose',
      exp,
    });

    await expect(verifyPrincipalSessionToken(grantJwt)).rejects.toThrow('Invalid token purpose');
  });

  it('throws for expired session token', async () => {
    const token = await signPrincipalSessionToken(
      { principalId: 'user_exp_sess', developerId: 'dev_exp_sess' },
      -1, // already expired
    );

    await expect(verifyPrincipalSessionToken(token)).rejects.toThrow();
  });
});

describe('verifyGrantToken — missing claims', () => {
  it('throws when dev claim is missing', async () => {
    const { SignJWT } = await import('jose');
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({ scp: ['read'] })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://grantex.dev')
      .setSubject('user_no_dev')
      .setJti('tok_no_dev')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await expect(verifyGrantToken(jwt)).rejects.toThrow('Missing required grant token claims');
  });

  it('throws when scp claim is missing', async () => {
    const { SignJWT } = await import('jose');
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({ dev: 'dev_no_scp' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://grantex.dev')
      .setSubject('user_no_scp')
      .setJti('tok_no_scp')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await expect(verifyGrantToken(jwt)).rejects.toThrow('Missing required grant token claims');
  });
});

describe('verifyPrincipalSessionToken — missing claims', () => {
  it('throws when sub is missing', async () => {
    const { SignJWT } = await import('jose');
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({ dev: 'dev_no_sub', purpose: 'principal_dashboard' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://grantex.dev')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await expect(verifyPrincipalSessionToken(jwt)).rejects.toThrow('Missing required claims');
  });

  it('throws when dev is missing', async () => {
    const { SignJWT } = await import('jose');
    const { privateKey, kid } = getKeyPair();
    const jwt = await new SignJWT({ purpose: 'principal_dashboard' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://grantex.dev')
      .setSubject('user_no_dev_sess')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);

    await expect(verifyPrincipalSessionToken(jwt)).rejects.toThrow('Missing required claims');
  });
});

describe('parseExpiresIn', () => {
  it.each([
    ['30s', 30],
    ['5m', 300],
    ['24h', 86400],
    ['7d', 604800],
  ])('parses %s → %d seconds', (input, expected) => {
    expect(parseExpiresIn(input)).toBe(expected);
  });

  it('throws on invalid format', () => {
    expect(() => parseExpiresIn('1x')).toThrow();
    expect(() => parseExpiresIn('abc')).toThrow();
  });
});
