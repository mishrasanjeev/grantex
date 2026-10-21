// SPDX-License-Identifier: Apache-2.0
/**
 * The signing profile of spec/verification.md with keys generated for the
 * run: both algorithms end to end, the adversarial cases, and the refusals
 * that are programming errors rather than denials.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentHttpSigError,
  InMemoryNonceStore,
  jwkThumbprint,
  parseDictionary,
  publicJwk,
  sign,
  verify,
} from '../src/index.js';
import type { AgentJwk, AgentRequest, NonceStore, SignOptions, VerifyOptions } from '../src/index.js';

const PASSPORT = 'passport-placeholder.shopper-01.issuer.example~disclosure~kb';
const GRANT = 'grant-placeholder.shopper-01.nimbus-shopper-2.4';
const NOW = 1_790_000_000;

const keys: Record<string, AgentJwk> = {
  ed25519: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  'ecdsa-p256-sha256': generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
};

function signed(key: AgentJwk, overrides: Partial<SignOptions> = {}, request?: Partial<AgentRequest>) {
  const req: AgentRequest = {
    method: 'POST',
    url: 'https://merchant.example/v1/checkout',
    body: '{"cart_id":"c-1001"}',
    ...request,
  };
  const result = sign(req, { key, agentPassport: PASSPORT, agentGrant: GRANT, created: NOW, ...overrides });
  return { request: { ...req, headers: { ...result.headers } } as AgentRequest & { headers: Record<string, string> }, result };
}

function options(key: AgentJwk, overrides: Partial<VerifyOptions> = {}): VerifyOptions {
  const pub = publicJwk(key);
  const kid = jwkThumbprint(pub);
  return {
    expectedAuthority: 'merchant.example',
    now: NOW + 5,
    nonceStore: new InMemoryNonceStore(() => NOW),
    resolveKey: (keyid) => (keyid === kid ? pub : null),
    ...overrides,
  };
}

for (const [alg, key] of Object.entries(keys)) {
  describe(`${alg} end to end`, () => {
    it('verifies a signed request and returns the presentations', async () => {
      const { request, result } = signed(key, { agentTrust: 'trust-mark-placeholder.shopper-01' });
      expect(result.alg).toBe(alg);
      expect(result.expires - result.created).toBe(60);
      expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const out = await verify(request, options(key));
      expect(out).toMatchObject({
        ok: true,
        alg,
        keyid: jwkThumbprint(key),
        created: NOW,
        expires: NOW + 60,
        agentPassport: PASSPORT,
        agentGrant: GRANT,
        agentTrust: 'trust-mark-placeholder.shopper-01',
      });
    });

    it('produces a 64-octet r||s or R||S signature, not DER (RFC 9421 section 3.3)', () => {
      const { result } = signed(key);
      const member = parseDictionary(result.headers.Signature!).get('sig1');
      if (!member || 'items' in member || member.value.type !== 'binary') throw new Error('no signature');
      expect(member.value.value.length).toBe(64);
    });

    it('denies Agent-Passport and Agent-Grant values swapped under a valid signature', async () => {
      const { request } = signed(key);
      const passport = request.headers['Agent-Passport']!;
      request.headers['Agent-Passport'] = request.headers['Agent-Grant']!;
      request.headers['Agent-Grant'] = passport;
      expect(await verify(request, options(key))).toEqual({
        ok: false,
        code: 'request_signature_invalid',
        reason: 'signature_mismatch',
      });
    });

    it('denies a replayed nonce through the injected store', async () => {
      const { request } = signed(key);
      const nonceStore = new InMemoryNonceStore(() => NOW);
      expect(await verify(request, options(key, { nonceStore }))).toMatchObject({ ok: true });
      expect(await verify(request, options(key, { nonceStore }))).toEqual({
        ok: false,
        code: 'request_signature_invalid',
        reason: 'nonce_replayed',
      });
    });

    it('denies a request for another @authority', async () => {
      const { request } = signed(key);
      expect(await verify(request, options(key, { expectedAuthority: 'other-merchant.example' }))).toEqual({
        ok: false,
        code: 'request_signature_invalid',
        reason: 'authority_mismatch',
      });
      // Signed for merchant.example, received by other-merchant.example as an origin-form target.
      const relayed = { ...request, url: '/v1/checkout' };
      expect(await verify(relayed, options(key, { expectedAuthority: 'other-merchant.example' }))).toEqual({
        ok: false,
        code: 'request_signature_invalid',
        reason: 'signature_mismatch',
      });
    });

    it('denies a stale signature', async () => {
      const { request } = signed(key, { expires: NOW + 300 });
      expect(await verify(request, options(key, { now: NOW + 300 + 9 }))).toMatchObject({ ok: true });
      const again = signed(key, { expires: NOW + 300, nonce: 'another-nonce-0000000000000' }).request;
      expect(await verify(again, options(key, { now: NOW + 300 + 10 }))).toEqual({
        ok: false,
        code: 'request_signature_stale',
        reason: 'expired',
      });
    });
  });
}

describe('presentations over 6 KB', () => {
  const big = `passport-placeholder.shopper-01${'~disclosure'.repeat(620)}`;
  const key = keys.ed25519!;

  it('are carried in the body under agent_credentials and checked against the header hash', async () => {
    const body = JSON.stringify({ cart_id: 'c-1', agent_credentials: { agent_passport: big } });
    const { request, result } = signed(key, { agentPassport: big }, { body });
    expect(result.headers['Agent-Passport']).toMatch(/^body;sha-256=:[A-Za-z0-9+/]{43}=:$/);
    expect(await verify(request, options(key))).toMatchObject({ ok: true, agentPassport: big });
  });

  it('cannot be signed unless the body carries them', () => {
    expect(() => signed(key, { agentPassport: big })).toThrow(AgentHttpSigError);
    const other = JSON.stringify({ agent_credentials: { agent_passport: `${big}x` } });
    expect(() => signed(key, { agentPassport: big }, { body: other })).toThrow(AgentHttpSigError);
  });

  it('are read only from content nested at most 64 deep, and numbers of any length are read', async () => {
    const withNote = (note: string) =>
      `{"cart_id":"c-1","agent_credentials":{"agent_passport":"${big}"},"note":${note}}`;
    const deep = withNote(`${'['.repeat(64)}${']'.repeat(64)}`);
    expect(() => signed(key, { agentPassport: big }, { body: deep })).toThrow(/nested more than 64 deep/);
    const limit = withNote(`${'['.repeat(63)}${']'.repeat(63)}`);
    const { request } = signed(key, { agentPassport: big }, { body: limit });
    expect(await verify(request, options(key))).toMatchObject({ ok: true });
    const long = withNote('9'.repeat(5000));
    const { request: longRequest } = signed(key, { agentPassport: big }, { body: long });
    expect(await verify(longRequest, options(key))).toMatchObject({ ok: true, agentPassport: big });
  });
});

describe('sign refuses what the profile does not allow', () => {
  const key = keys.ed25519!;
  it('a window over 300 seconds, or none', () => {
    expect(() => signed(key, { expires: NOW + 301 })).toThrow(/300/);
    expect(() => signed(key, { expires: NOW })).toThrow(AgentHttpSigError);
  });
  it('another tag', () => {
    expect(() => signed(key, { tag: 'web-bot-auth' })).toThrow(AgentHttpSigError);
    expect(() => signed(key, { tag: 'agent-payer-auth' })).not.toThrow();
  });
  it('a keyid that is not the key thumbprint', () => {
    expect(() => signed(key, { keyid: jwkThumbprint(keys['ecdsa-p256-sha256']!) })).toThrow(AgentHttpSigError);
    expect(() => signed(key, { keyid: jwkThumbprint(key) })).not.toThrow();
  });
  it('a public key, or a private key whose public half does not match', () => {
    expect(() => signed(publicJwk(key))).toThrow(AgentHttpSigError);
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    expect(() => signed({ ...key, x: other.x! })).toThrow(AgentHttpSigError);
  });
  it('an unsupported key or a conflicting alg', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'jwk' });
    expect(() => signed(p384)).toThrow(AgentHttpSigError);
    expect(() => signed({ ...key, alg: 'ES256' })).toThrow(AgentHttpSigError);
    expect(() => signed({ ...key, alg: 'EdDSA' })).not.toThrow();
  });
  it('a malformed nonce', () => {
    expect(() => signed(key, { nonce: 'short' })).toThrow(AgentHttpSigError);
    expect(() => signed(key, { nonce: 'has space in it 0000000000' })).toThrow(AgentHttpSigError);
  });
  it('a relative, non-http or userinfo URL', () => {
    expect(() => signed(key, {}, { url: '/v1/checkout' })).toThrow(AgentHttpSigError);
    expect(() => signed(key, {}, { url: 'ftp://merchant.example/x' })).toThrow(AgentHttpSigError);
    expect(() => signed(key, {}, { url: 'https://user@merchant.example/x' })).toThrow(AgentHttpSigError);
  });
  it('a presentation that is empty or not printable ASCII', () => {
    expect(() => signed(key, { agentPassport: '' })).toThrow(AgentHttpSigError);
    expect(() => signed(key, { agentGrant: 'has space' })).toThrow(AgentHttpSigError);
    expect(() => signed(key, { agentGrant: 'café' })).toThrow(AgentHttpSigError);
  });
});

describe('verify fails closed', () => {
  const key = keys.ed25519!;
  it('raises a key resolver failure instead of answering', async () => {
    const { request } = signed(key);
    await expect(
      verify(request, options(key, { resolveKey: async () => { throw new Error('registry unavailable'); } })),
    ).rejects.toThrow('registry unavailable');
  });
  it('raises a nonce store failure instead of answering', async () => {
    const { request } = signed(key);
    const failing: NonceStore = { checkAndStore: async () => { throw new Error('store unavailable'); } };
    await expect(verify(request, options(key, { nonceStore: failing }))).rejects.toThrow('store unavailable');
  });
  it('does not record a nonce for a request that fails', async () => {
    const { request } = signed(key);
    const nonceStore = new InMemoryNonceStore(() => NOW);
    const tampered = { ...request, body: '{"cart_id":"c-9999"}' };
    expect(await verify(tampered, options(key, { nonceStore }))).toMatchObject({ reason: 'content_digest_mismatch' });
    expect(await verify(request, options(key, { nonceStore }))).toMatchObject({ ok: true });
  });
  it('denies a resolved private key', async () => {
    const { request } = signed(key);
    expect(await verify(request, options(key, { resolveKey: () => key }))).toMatchObject({ reason: 'key_mismatch' });
  });
  it('refuses a clock skew over 60 seconds or an unusable authority', async () => {
    const { request } = signed(key);
    await expect(verify(request, options(key, { clockSkewSeconds: 61 }))).rejects.toThrow(AgentHttpSigError);
    await expect(verify(request, options(key, { expectedAuthority: 'https://merchant.example' }))).rejects.toThrow(AgentHttpSigError);
    await expect(verify(request, options(key, { expectedAuthority: '' }))).rejects.toThrow(AgentHttpSigError);
    // A default port would never match @authority (spec section 4.1).
    await expect(verify(request, options(key, { expectedAuthority: 'merchant.example:443' }))).rejects.toThrow(/default port/);
    await expect(verify(request, options(key, { expectedAuthority: 'merchant.example:80' }))).rejects.toThrow(/default port/);
    expect(await verify(request, options(key, { expectedAuthority: 'merchant.example:8443' }))).toMatchObject({
      reason: 'authority_mismatch',
    });
  });
  it('refuses a verifier clock that is not a finite, non-negative number', async () => {
    // NaN compares false with everything, so both time checks would pass a stale signature.
    const { request } = signed(key);
    expect(await verify(request, options(key, { now: NOW + 300 + 10 }))).toMatchObject({ reason: 'expired' });
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, '1790000005' as unknown as number]) {
      await expect(verify(request, options(key, { now }))).rejects.toThrow(/now must be/);
    }
  });
  it('matches the expected authority case-insensitively', async () => {
    const { request } = signed(key);
    expect(await verify(request, options(key, { expectedAuthority: 'Merchant.Example' }))).toMatchObject({ ok: true });
  });
});

describe('InMemoryNonceStore', () => {
  it('forgets a nonce after it expires', async () => {
    let now = 1000;
    const store = new InMemoryNonceStore(() => now);
    expect(await store.checkAndStore('k', 'n', 1010)).toBe(true);
    expect(await store.checkAndStore('k', 'n', 1010)).toBe(false);
    now = 1011;
    expect(await store.checkAndStore('k', 'n', 1020)).toBe(true);
  });
});

describe('request shapes', () => {
  const key = keys.ed25519!;
  it('accepts a Fetch Headers object, a record and a list of pairs', async () => {
    const { request } = signed(key);
    const asHeaders = { ...request, headers: new Headers(request.headers) };
    const asPairs = { ...request, headers: Object.entries(request.headers) };
    expect(await verify(asHeaders, options(key))).toMatchObject({ ok: true });
    expect(await verify(asPairs, options(key))).toMatchObject({ ok: true });
  });
  it('accepts the body as octets', async () => {
    const { request } = signed(key, {}, { body: new TextEncoder().encode('{"cart_id":"c-1001"}') });
    expect(await verify({ ...request, body: '{"cart_id":"c-1001"}' }, options(key))).toMatchObject({ ok: true });
  });
});
