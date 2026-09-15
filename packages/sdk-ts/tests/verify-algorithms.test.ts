import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type CryptoKey,
  type JWK,
} from 'jose';
import { clearRemoteJwksCache, GRANT_TOKEN_ALGORITHMS, verifyGrantToken } from '../src/verify.js';
import { GrantexTokenError } from '../src/errors.js';

// Real JOSE verification against a JWK Set served by a stubbed fetch.

const ISSUER = 'https://auth.example.com';
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

const CLAIMS = {
  agt: 'did:grantex:ag_alg',
  dev: 'dev_alg',
  scp: ['calendar:read'],
  grnt: 'grnt_alg',
};

interface KeyFixture {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

let rsa: KeyFixture;
let ec: KeyFixture;
let rsaPublicPem: string;

async function fixture(alg: 'RS256' | 'ES256', kid: string): Promise<KeyFixture> {
  const pair = await generateKeyPair(alg, { extractable: true });
  return { privateKey: pair.privateKey, publicJwk: { ...(await exportJWK(pair.publicKey)), kid, alg, use: 'sig' } };
}

beforeAll(async () => {
  rsa = await fixture('RS256', 'rsa-1');
  ec = await fixture('ES256', 'ec-1');
  const rsaPair = await generateKeyPair('RS256', { extractable: true });
  rsaPublicPem = await exportSPKI(rsaPair.publicKey);
});

function serveJwks(keys: JWK[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
}

afterEach(() => {
  clearRemoteJwksCache();
  vi.unstubAllGlobals();
});

async function sign(
  key: CryptoKey | Uint8Array,
  header: { alg: string; kid?: string },
): Promise<string> {
  return new SignJWT(CLAIMS)
    .setProtectedHeader({ ...header, typ: 'at+jwt' })
    .setIssuer(ISSUER)
    .setSubject('user_alg')
    .setJti('tok_alg')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);
}

function withHeader(token: string, header: Record<string, unknown>): string {
  const [, payload, signature] = token.split('.');
  return `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${payload}.${signature}`;
}

const verify = (token: string, algorithms?: Array<'RS256' | 'ES256'>) =>
  verifyGrantToken(token, { jwksUri: JWKS_URI, ...(algorithms ? { algorithms } : {}) });

describe('verifyGrantToken algorithm allowlist', () => {
  it('allows exactly RS256 and ES256 by default', () => {
    expect([...GRANT_TOKEN_ALGORITHMS]).toEqual(['RS256', 'ES256']);
  });

  it('verifies an ES256 token from a JWK Set with RSA and EC keys', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    const grant = await verify(await sign(ec.privateKey, { alg: 'ES256', kid: 'ec-1' }));
    expect(grant).toMatchObject({ principalId: 'user_alg', agentDid: 'did:grantex:ag_alg', grantId: 'grnt_alg' });
  });

  it('verifies an RS256 token from the same JWK Set', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    await expect(verify(await sign(rsa.privateKey, { alg: 'RS256', kid: 'rsa-1' }))).resolves.toMatchObject({
      tokenId: 'tok_alg',
    });
  });

  it('rejects an ES256 token whose kid names the RSA key', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    const token = await sign(ec.privateKey, { alg: 'ES256', kid: 'rsa-1' });
    await expect(verify(token)).rejects.toBeInstanceOf(GrantexTokenError);
  });

  it('rejects an RS256 token whose kid names the EC key', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    const token = await sign(rsa.privateKey, { alg: 'RS256', kid: 'ec-1' });
    await expect(verify(token)).rejects.toBeInstanceOf(GrantexTokenError);
  });

  it('rejects an RS256 token whose alg header was changed to ES256', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    const token = await sign(rsa.privateKey, { alg: 'RS256', kid: 'rsa-1' });
    await expect(verify(withHeader(token, { alg: 'ES256', kid: 'rsa-1', typ: 'at+jwt' }))).rejects.toThrow(GrantexTokenError);
    await expect(verify(withHeader(token, { alg: 'ES256', kid: 'ec-1', typ: 'at+jwt' }))).rejects.toThrow(GrantexTokenError);
  });

  it('rejects an ES256 token whose alg header was changed to RS256', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    const token = await sign(ec.privateKey, { alg: 'ES256', kid: 'ec-1' });
    await expect(verify(withHeader(token, { alg: 'RS256', kid: 'ec-1', typ: 'at+jwt' }))).rejects.toThrow(GrantexTokenError);
  });

  it('rejects a key published for a different algorithm than the token uses', async () => {
    // An EC key mislabelled RS256 in the JWK Set is never used for ES256.
    serveJwks([{ ...ec.publicJwk, alg: 'RS256' }]);
    await expect(verify(await sign(ec.privateKey, { alg: 'ES256', kid: 'ec-1' }))).rejects.toThrow(GrantexTokenError);
  });

  it('rejects an ES256 token when the JWK Set key is not on P-256', async () => {
    const p384 = await generateKeyPair('ES384', { extractable: true });
    serveJwks([{ ...(await exportJWK(p384.publicKey)), kid: 'ec-1', use: 'sig' }]);
    await expect(verify(await sign(ec.privateKey, { alg: 'ES256', kid: 'ec-1' }))).rejects.toThrow(GrantexTokenError);
  });

  it('rejects HS256 tokens keyed with published public key material', async () => {
    serveJwks([rsa.publicJwk]);
    const secret = new TextEncoder().encode(rsaPublicPem);
    const token = await sign(secret, { alg: 'HS256', kid: 'rsa-1' });
    await expect(verify(token)).rejects.toThrow(/alg/);
  });

  it('rejects alg none', async () => {
    serveJwks([rsa.publicJwk]);
    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'rsa-1' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      ...CLAIMS, iss: ISSUER, sub: 'user_alg', jti: 'tok_alg',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    await expect(verify(`${header}.${payload}.`)).rejects.toThrow(GrantexTokenError);
  });

  it('rejects an unknown kid without falling back to another key', async () => {
    serveJwks([ec.publicJwk]);
    const token = await sign(ec.privateKey, { alg: 'ES256', kid: 'ec-rotated' });
    await expect(verify(token)).rejects.toThrow(GrantexTokenError);
  });

  it('narrows the allowlist with options.algorithms', async () => {
    serveJwks([rsa.publicJwk, ec.publicJwk]);
    const esToken = await sign(ec.privateKey, { alg: 'ES256', kid: 'ec-1' });
    await expect(verify(esToken, ['RS256'])).rejects.toThrow(/alg/);
    await expect(verify(esToken, ['ES256'])).resolves.toBeDefined();
  });

  it('never widens the allowlist', async () => {
    serveJwks([rsa.publicJwk]);
    const token = await sign(rsa.privateKey, { alg: 'RS256', kid: 'rsa-1' });
    await expect(verify(token, ['HS256'] as never)).rejects.toThrow('Unsupported grant token algorithm HS256');
    await expect(verify(token, ['none'] as never)).rejects.toThrow('Unsupported grant token algorithm none');
    await expect(verify(token, [])).rejects.toThrow('algorithms must list at least one of RS256, ES256');
  });
});
