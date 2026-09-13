import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as jose from 'jose';
import { verifyPassport, clearJwksCache } from '../src/verifier.js';
import type { AgentPassportCredential } from '../src/types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCredential(): AgentPassportCredential {
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://grantex.dev/contexts/mpp/v1'],
    type: ['VerifiableCredential', 'AgentPassportCredential'],
    id: 'urn:grantex:passport:cache',
    issuer: 'did:web:grantex.dev',
    validFrom: new Date(Date.now() - 3600_000).toISOString(),
    validUntil: new Date(Date.now() + 86400_000).toISOString(),
    credentialSubject: {
      id: 'did:grantex:ag_cache',
      type: 'AIAgent',
      humanPrincipal: 'did:grantex:user_cache',
      grantId: 'grnt_cache',
      allowedMPPCategories: ['inference'],
      maxTransactionAmount: { amount: 50, currency: 'USDC' },
      paymentRails: ['tempo'],
      delegationDepth: 0,
    },
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      verificationMethod: 'did:web:grantex.dev#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: '',
    },
  } as unknown as AgentPassportCredential;
}

async function makeKey(kid: string) {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { privateKey, jwk };
}

async function signWith(privateKey: jose.KeyLike | Uint8Array, kid: string): Promise<string> {
  const credential = makeCredential();
  const jwt = await new jose.SignJWT({ vc: credential })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer('did:web:grantex.dev')
    .setSubject(credential.credentialSubject.id)
    .setJti(credential.id)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(privateKey);
  credential.proof.proofValue = jwt;
  return Buffer.from(JSON.stringify(credential)).toString('base64url');
}

function stubJwks(getKeys: () => jose.JWK[]) {
  const fetchMock = vi.fn().mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ keys: getKeys() }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('JWKS cache', () => {
  beforeEach(() => {
    clearJwksCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches the JWKS once and serves later verifications from cache', async () => {
    const key = await makeKey('key-1');
    const fetchMock = stubJwks(() => [key.jwk]);
    const encoded = await signWith(key.privateKey, 'key-1');

    await expect(verifyPassport(encoded)).resolves.toMatchObject({ valid: true });
    await expect(verifyPassport(encoded)).resolves.toMatchObject({ valid: true });
    await expect(verifyPassport(encoded)).resolves.toMatchObject({ valid: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-fetches on an unknown kid after the cooldown (key rotation) but not inside it', async () => {
    const oldKey = await makeKey('key-old');
    const newKey = await makeKey('key-new');
    let served = [oldKey.jwk];
    const fetchMock = stubJwks(() => served);

    // Warm the cache with the old key.
    await expect(verifyPassport(await signWith(oldKey.privateKey, 'key-old'))).resolves.toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Issuer rotates. Inside the cooldown the unknown kid is rejected without
    // hitting the network again.
    served = [newKey.jwk];
    const rotated = await signWith(newKey.privateKey, 'key-new');
    await expect(verifyPassport(rotated)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the cooldown the unknown kid triggers one refresh and then verifies.
    vi.advanceTimersByTime(31_000);
    await expect(verifyPassport(rotated)).resolves.toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remembers a failed fetch briefly instead of retrying on every call', async () => {
    const key = await makeKey('key-1');
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const encoded = await signWith(key.privateKey, 'key-1');

    await expect(verifyPassport(encoded)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    await expect(verifyPassport(encoded)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once the negative-cache window lapses and the issuer recovers, it works.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ keys: [key.jwk] }) });
    vi.advanceTimersByTime(31_000);
    await expect(verifyPassport(encoded)).resolves.toMatchObject({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a proof signed with a non-RS256 algorithm even if the JWKS lists a matching key', async () => {
    const { privateKey, publicKey } = await jose.generateKeyPair('ES256');
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = 'es-1';
    jwk.alg = 'ES256';
    stubJwks(() => [jwk]);
    const credential = makeCredential();
    credential.proof.proofValue = await new jose.SignJWT({ vc: credential })
      .setProtectedHeader({ alg: 'ES256', kid: 'es-1' })
      .setIssuer('did:web:grantex.dev')
      .setJti(credential.id)
      .setExpirationTime('24h')
      .sign(privateKey);
    const encoded = Buffer.from(JSON.stringify(credential)).toString('base64url');

    await expect(verifyPassport(encoded)).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' });
  });
});
