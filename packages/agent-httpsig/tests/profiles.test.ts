// SPDX-License-Identifier: Apache-2.0
/**
 * The profile-driven signer and verifier: the grantex profile unchanged (the
 * shared vectors through signWithProfile / verifyWithProfile), Visa TAP and
 * Web Bot Auth end to end with both key types, their refusals, and the
 * RFC 9421 component parameters they need (`key`, `req`, `@target-uri`).
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentHttpSigError,
  COVERED_COMPONENTS,
  InMemoryNonceStore,
  MAX_SIGNATURE_WINDOW_SECONDS,
  SIGNATURE_PROFILES,
  TAP_BROWSER_TAG,
  TAP_MAX_WINDOW_SECONDS,
  WEB_BOT_AUTH_TAG,
  createSignatureBase,
  jwkThumbprint,
  parseDictionary,
  parseSignatureAgent,
  publicJwk,
  serializeSignatureAgent,
  sign,
  signWithProfile,
  signatureBaseFor,
  verifyWithProfile,
} from '../src/index.js';
import type {
  AgentJwk,
  AgentRequest,
  KeyReference,
  TapVerifyOptions,
  WebBotAuthVerifyOptions,
} from '../src/index.js';
import { vectorPrivateKey, vectors } from './helpers.js';

const NOW = 1_790_000_000;
const keys: Record<string, AgentJwk> = {
  ed25519: generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
  'ecdsa-p256-sha256': generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
};

const request = (): AgentRequest & { headers: Record<string, string> } => ({
  method: 'POST',
  url: 'https://merchant.example/v1/checkout?cart=c-1001',
  headers: { 'content-type': 'application/json' },
  body: '{"cart_id":"c-1001"}',
});

function withHeaders(req: AgentRequest & { headers: Record<string, string> }, headers: Record<string, string>) {
  return { ...req, headers: { ...req.headers, ...headers } };
}

describe('grantex profile (unchanged default)', () => {
  it('is the spec/verification.md profile of the shared vectors', () => {
    expect(SIGNATURE_PROFILES.grantex.tags).toEqual([vectors.profile.tag]);
    expect(SIGNATURE_PROFILES.grantex.defaultComponents).toEqual([...COVERED_COMPONENTS]);
    expect(SIGNATURE_PROFILES.grantex.maxWindowSeconds).toBe(MAX_SIGNATURE_WINDOW_SECONDS);
  });

  for (const v of vectors.sign) {
    it(`signWithProfile without a profile reproduces sign vector ${v.name}`, () => {
      const key = vectorPrivateKey(v.key);
      const options = {
        key,
        agentPassport: v.presentations.agent_passport,
        agentGrant: v.presentations.agent_grant,
        ...(v.presentations.agent_trust ? { agentTrust: v.presentations.agent_trust } : {}),
        created: v.params.created,
        expires: v.params.expires,
        nonce: v.params.nonce,
        label: v.params.label,
      };
      const req = { method: v.request.method, url: v.request.url, headers: v.request.headers ?? [], body: v.request.body };
      const implicit = signWithProfile(req, options);
      const explicit = signWithProfile(req, { ...options, profile: 'grantex' });
      const direct = sign(req, options);
      expect(implicit.headers).toEqual(direct.headers);
      expect(explicit.headers).toEqual(direct.headers);
      expect(Object.entries(implicit.headers)).toEqual(v.headers);
      expect(implicit.signatureBase).toBe(v.signature_base);
    });
  }

  for (const v of vectors.verify) {
    it(`verifyWithProfile without a profile answers verify vector ${v.name} identically`, async () => {
      const pub = vectors.keys[v.key]!.public_jwk;
      const out = await verifyWithProfile(v.request, {
        expectedAuthority: v.expected_authority,
        now: v.now,
        nonceStore: (() => {
          const store = new InMemoryNonceStore(() => v.now);
          for (const [k, n] of v.seen_nonces) store.checkAndStore(k, n, v.now + 3600);
          return store;
        })(),
        resolveKey: async () => (v.key_known ? pub : null),
      });
      if (v.expected.ok) {
        expect(out.ok).toBe(true);
        expect(out).toMatchObject({ profile: 'grantex', tag: 'agent-payer-auth' });
      } else {
        expect(out).toEqual({ ok: false, profile: 'grantex', code: v.expected.code, reason: v.expected.reason });
      }
    });
  }
});

describe('RFC 9421 component parameters', () => {
  it('section 2.1.2: Dictionary members by key, re-serialized', () => {
    const message = {
      method: 'GET',
      url: 'https://example.com/',
      headers: [
        ['Example-Dict', ' a=1,    b=2;x=1;y=2,   c=(a   b   c), d'],
        ['Signature-Input', 'sig1=("example-dict";key="a" "example-dict";key="d" "example-dict";key="b" "example-dict";key="c");created=1'],
      ] as [string, string][],
    };
    expect(signatureBaseFor(message, 'sig1').split('\n').slice(0, 4)).toEqual([
      '"example-dict";key="a": 1',
      '"example-dict";key="d": ?1',
      '"example-dict";key="b": 2;x=1;y=2',
      '"example-dict";key="c": (a b c)',
    ]);
  });

  it('section 2.1.2: a missing member fails', () => {
    const message = {
      method: 'GET',
      url: 'https://example.com/',
      headers: [['Example-Dict', 'a=1'], ['Signature-Input', 'sig1=("example-dict";key="z");created=1']] as [string, string][],
    };
    expect(() => signatureBaseFor(message, 'sig1')).toThrow(AgentHttpSigError);
  });

  it('section 2.2.2: @target-uri', () => {
    const message = {
      method: 'POST',
      url: 'https://www.example.com/path?param=value',
      headers: [['Signature-Input', 'sig1=("@target-uri");created=1']] as [string, string][],
    };
    expect(signatureBaseFor(message, 'sig1').split('\n')[0]).toBe('"@target-uri": https://www.example.com/path?param=value');
  });

  it('section 2.4: req reads the related request, and only for a response', () => {
    const related = { method: 'POST', url: 'https://example.com/foo?param=Value&Pet=dog' };
    const response = {
      status: 503,
      headers: [
        ['Content-Type', 'application/json'],
        ['Signature-Input', 'reqres=("@status" "content-type" "@authority";req "@method";req "@path";req);created=1618884479'],
      ] as [string, string][],
    };
    expect(signatureBaseFor(response, 'reqres', related)).toBe(
      [
        '"@status": 503',
        '"content-type": application/json',
        '"@authority";req: example.com',
        '"@method";req: POST',
        '"@path";req: /foo',
        '"@signature-params": ("@status" "content-type" "@authority";req "@method";req "@path";req);created=1618884479',
      ].join('\n'),
    );
    expect(() => signatureBaseFor(response, 'reqres')).toThrow(/related request/);
    expect(() =>
      signatureBaseFor({ ...related, headers: [['Signature-Input', 'sig1=("@method";req);created=1']] }, 'sig1'),
    ).toThrow(/needs a response/);
  });

  it('draft-ietf-webbotauth-httpsig-protocol-00 section 5.2.5: the example base', () => {
    const message = {
      method: 'GET',
      url: 'https://origin.example.com/path/to/resource',
      headers: [
        ['Signature-Input', 'sig=("@authority" "signature-agent";key="sig");created=1700000000;expires=1700011111;keyid="ba3e64==";tag="web-bot-auth"'],
        ['Signature-Agent', 'sig="https://signer.example.com"'],
      ] as [string, string][],
    };
    expect(signatureBaseFor(message, 'sig')).toBe(
      [
        '"@authority": origin.example.com',
        '"signature-agent";key="sig": "https://signer.example.com"',
        '"@signature-params": ("@authority" "signature-agent";key="sig");created=1700000000;expires=1700011111;keyid="ba3e64==";tag="web-bot-auth"',
      ].join('\n'),
    );
  });
});

function tapOptions(key: AgentJwk, keyid: string, overrides: Partial<TapVerifyOptions> = {}) {
  const pub = publicJwk(key);
  const seen: KeyReference[] = [];
  const options: TapVerifyOptions = {
    profile: 'tap',
    expectedAuthority: 'merchant.example',
    now: NOW + 5,
    nonceStore: new InMemoryNonceStore(() => NOW),
    resolveKey: (ref) => {
      seen.push(ref);
      return ref.keyid === keyid ? pub : null;
    },
    ...overrides,
  };
  return { options, seen };
}

for (const [alg, key] of Object.entries(keys)) {
  describe(`TAP profile (${alg})`, () => {
    it('signs @authority and @path with created, expires, keyid, alg, nonce and tag, and verifies', async () => {
      const req = request();
      const signed = signWithProfile(req, { profile: 'tap', key, keyid: 'primary-key-01', created: NOW });
      expect(signed.tag).toBe('agent-payer-auth');
      expect(signed.expires - signed.created).toBe(TAP_MAX_WINDOW_SECONDS);
      expect(signed.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(signed.headers['Signature-Input']).toBe(
        `sig1=("@authority" "@path");created=${NOW};expires=${NOW + 480};keyid="primary-key-01";alg="${alg}";nonce="${signed.nonce}";tag="agent-payer-auth"`,
      );
      expect(signed.headers['Signature-Agent']).toBeUndefined();
      const { options, seen } = tapOptions(key, 'primary-key-01');
      const out = await verifyWithProfile(withHeaders(req, signed.headers), options);
      expect(out).toMatchObject({ ok: true, profile: 'tap', tag: 'agent-payer-auth', keyid: 'primary-key-01', alg, nonce: signed.nonce });
      expect(seen).toEqual([{ profile: 'tap', tag: 'agent-payer-auth', keyid: 'primary-key-01', signatureAgent: null }]);
    });

    it('covers extra components and checks a covered Content-Digest', async () => {
      const req = request();
      const signed = signWithProfile(req, {
        profile: 'tap',
        key,
        keyid: 'k1',
        tag: TAP_BROWSER_TAG,
        created: NOW,
        components: ['@method', '@authority', '@path', 'content-type', 'content-digest'],
      });
      const { options } = tapOptions(key, 'k1', { requiredComponents: ['content-digest'] });
      const good = withHeaders(req, signed.headers);
      expect((await verifyWithProfile(good, options)).ok).toBe(true);
      const tampered = { ...good, body: '{"cart_id":"c-9999"}' };
      expect(await verifyWithProfile(tampered, tapOptions(key, 'k1').options)).toMatchObject({ ok: false, reason: 'content_digest_mismatch' });
    });
  });
}

describe('TAP refusals', () => {
  const key = keys.ed25519!;
  const signedTap = (overrides: Record<string, unknown> = {}) => {
    const req = request();
    const s = signWithProfile(req, { profile: 'tap', key, keyid: 'k1', created: NOW, ...overrides });
    return withHeaders(req, s.headers);
  };

  it('refuses at signing a window over 8 minutes and a missing @path', () => {
    expect(() => signWithProfile(request(), { profile: 'tap', key, created: NOW, expires: NOW + 481 })).toThrow(/1 to 480/);
    expect(() => signWithProfile(request(), { profile: 'tap', key, components: ['@authority'] })).toThrow(/@authority and @path/);
    expect(() => signWithProfile(request(), { profile: 'tap', key, tag: 'web-bot-auth' })).toThrow(/TAP tag/);
  });

  it('denies a window over 8 minutes, a stale or future signature', async () => {
    const pub = publicJwk(key);
    const ok = (now: number): TapVerifyOptions => ({
      profile: 'tap',
      expectedAuthority: 'merchant.example',
      now,
      nonceStore: new InMemoryNonceStore(),
      resolveKey: () => pub,
    });
    expect(await verifyWithProfile(signedTap(), ok(NOW + 470))).toMatchObject({ ok: true });
    expect(await verifyWithProfile(signedTap(), ok(NOW + 480 + 10))).toMatchObject({ ok: false, reason: 'expired', code: 'request_signature_stale' });
    expect(await verifyWithProfile(signedTap(), ok(NOW - 60))).toMatchObject({ ok: false, reason: 'created_in_future' });
  });

  it('refuses a nonce seen in the last 8 minutes, even after the first signature expired', async () => {
    const store = new InMemoryNonceStore(() => NOW + 100);
    const pub = publicJwk(key);
    const first = signedTap({ nonce: 'session-123', expires: NOW + 60 });
    const opts = (now: number): TapVerifyOptions => ({
      profile: 'tap', expectedAuthority: 'merchant.example', now, nonceStore: store, resolveKey: () => pub,
    });
    expect(await verifyWithProfile(first, opts(NOW + 5))).toMatchObject({ ok: true });
    const second = signedTap({ nonce: 'session-123', created: NOW + 100 });
    expect(await verifyWithProfile(second, opts(NOW + 105))).toMatchObject({ ok: false, reason: 'nonce_replayed' });
  });

  it('denies differing nonces across the signatures of one message', async () => {
    const req = signedTap({ nonce: 'n-1' });
    const other = signWithProfile(request(), { profile: 'tap', key, keyid: 'k1', created: NOW, nonce: 'n-2', label: 'sig2', tag: TAP_BROWSER_TAG });
    const both = {
      ...req,
      headers: {
        ...req.headers,
        'Signature-Input': `${req.headers['Signature-Input']}, ${other.headers['Signature-Input']}`,
        Signature: `${req.headers.Signature}, ${other.headers.Signature}`,
      },
    };
    const { options } = tapOptions(key, 'k1', { label: 'sig1' });
    expect(await verifyWithProfile(both, options)).toMatchObject({ ok: false, reason: 'nonce_mismatch' });
  });

  it('denies a tag the relying party does not accept, a missing nonce, and the sample keyId spelling', async () => {
    const { options } = tapOptions(key, 'k1', { tags: ['agent-browser-auth'] });
    expect(await verifyWithProfile(signedTap(), options)).toMatchObject({ ok: false, reason: 'tag_not_accepted' });
    const req = signedTap();
    const noNonce = { ...req, headers: { ...req.headers, 'Signature-Input': req.headers['Signature-Input']!.replace(/;nonce="[^"]*"/, '') } };
    expect(await verifyWithProfile(noNonce, tapOptions(key, 'k1').options)).toMatchObject({ ok: false, reason: 'nonce_missing' });
    // The sample implementation writes keyId; RFC 9421 and the TAP specification use keyid.
    const camel = { ...req, headers: { ...req.headers, 'Signature-Input': req.headers['Signature-Input']!.replace('keyid=', 'keyId=') } };
    expect(() => parseDictionary(camel.headers['Signature-Input']!)).toThrow();
    expect(await verifyWithProfile(camel, tapOptions(key, 'k1').options)).toMatchObject({ ok: false, reason: 'signature_malformed' });
  });

  it('denies an alg parameter that does not match the key, and accepts the TAP spelling Ed25519', async () => {
    const req = signedTap({ includeAlg: false });
    const input = req.headers['Signature-Input']!;
    const swap = (alg: string) => ({ ...req, headers: { ...req.headers, 'Signature-Input': input.replace(';nonce', `;alg="${alg}";nonce`) } });
    expect(await verifyWithProfile(swap('ecdsa-p256-sha256'), tapOptions(key, 'k1').options)).toMatchObject({ ok: false, reason: 'algorithm_mismatch' });
    // The alg parameter is covered by the signature, so changing it also breaks the signature: sign it in.
    const pub = publicJwk(key);
    const resigned = signWithProfile(request(), { profile: 'tap', key, keyid: 'k1', created: NOW });
    expect(resigned.headers['Signature-Input']).toContain('alg="ed25519"');
    expect(await verifyWithProfile(withHeaders(request(), resigned.headers), {
      profile: 'tap', expectedAuthority: 'merchant.example', now: NOW + 1, nonceStore: new InMemoryNonceStore(), resolveKey: () => pub,
    })).toMatchObject({ ok: true });
  });

  it('denies an unknown key and a signature by another key', async () => {
    expect(await verifyWithProfile(signedTap(), tapOptions(key, 'other').options)).toMatchObject({ ok: false, reason: 'key_unknown' });
    const wrong = publicJwk(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }));
    expect(await verifyWithProfile(signedTap(), { ...tapOptions(key, 'k1').options, resolveKey: () => wrong })).toMatchObject({
      ok: false,
      reason: 'signature_mismatch',
    });
  });

  it('is not read as the grantex profile, and the grantex verifier refuses it', async () => {
    const out = await verifyWithProfile(signedTap(), {
      expectedAuthority: 'merchant.example',
      now: NOW + 5,
      nonceStore: new InMemoryNonceStore(),
      resolveKey: () => publicJwk(key),
    });
    expect(out).toMatchObject({ ok: false, profile: 'grantex', reason: 'covered_components_mismatch' });
  });
});

function wbaOptions(key: AgentJwk, overrides: Partial<WebBotAuthVerifyOptions> = {}) {
  const pub = publicJwk(key);
  const kid = jwkThumbprint(pub);
  const seen: KeyReference[] = [];
  const options: WebBotAuthVerifyOptions = {
    profile: 'web-bot-auth',
    expectedAuthority: 'merchant.example',
    now: NOW + 5,
    nonceStore: new InMemoryNonceStore(() => NOW),
    resolveKey: (ref) => {
      seen.push(ref);
      return ref.signatureAgent?.url === 'https://agents.example' && ref.keyid === kid ? pub : null;
    },
    ...overrides,
  };
  return { options, seen };
}

for (const [alg, key] of Object.entries(keys)) {
  describe(`Web Bot Auth profile (${alg})`, () => {
    it('signs @authority and the Signature-Agent member and verifies by (URL, keyid)', async () => {
      const req = request();
      const signed = signWithProfile(req, { profile: 'web-bot-auth', key, created: NOW, signatureAgent: { url: 'https://agents.example' } });
      const kid = jwkThumbprint(key);
      expect(signed.headers['Signature-Agent']).toBe('sig1="https://agents.example"');
      expect(signed.headers['Signature-Input']).toBe(
        `sig1=("@authority" "signature-agent";key="sig1");created=${NOW};expires=${NOW + 300};keyid="${kid}";nonce="${signed.nonce}";tag="web-bot-auth"`,
      );
      const { options, seen } = wbaOptions(key);
      const out = await verifyWithProfile(withHeaders(req, signed.headers), options);
      expect(out).toMatchObject({
        ok: true,
        profile: 'web-bot-auth',
        tag: WEB_BOT_AUTH_TAG,
        keyid: kid,
        alg,
        signatureAgent: { label: 'sig1', url: 'https://agents.example', type: 'directory' },
      });
      expect(seen[0]!.signatureAgent?.url).toBe('https://agents.example');
    });

    it('narrows with @target-uri, @method and content-digest, without a nonce', async () => {
      const req = request();
      const signed = signWithProfile(req, {
        profile: 'web-bot-auth',
        key,
        created: NOW,
        nonce: null,
        components: ['@method', '@target-uri', 'content-digest', 'signature-agent'],
        signatureAgent: { url: 'https://agents.example', type: 'jwks_uri' },
      });
      expect(signed.headers['Signature-Agent']).toBe('sig1="https://agents.example";type=jwks_uri');
      expect(signed.headers['Signature-Input']).not.toContain('nonce=');
      const out = await verifyWithProfile({ ...withHeaders(req, signed.headers), url: '/v1/checkout?cart=c-1001' }, wbaOptions(key).options);
      expect(out).toMatchObject({ ok: true, nonce: null, signatureAgent: { type: 'jwks_uri' } });
    });
  });
}

describe('Web Bot Auth refusals', () => {
  const key = keys.ed25519!;
  const signedWba = (overrides: Record<string, unknown> = {}) => {
    const req = request();
    const s = signWithProfile(req, { profile: 'web-bot-auth', key, created: NOW, signatureAgent: { url: 'https://agents.example' }, ...overrides });
    return withHeaders(req, s.headers);
  };

  it('refuses at signing a window over 24 hours and a missing @authority', () => {
    expect(() => signedWba({ expires: NOW + 86_401 })).toThrow(/1 to 86400/);
    expect(() => signedWba({ components: ['@path', 'signature-agent'] })).toThrow(/@authority or @target-uri/);
    expect(() => signedWba({ signatureAgent: { url: 'http://agents.example' } })).toThrow(/https URL/);
  });

  it('denies a signature without the Signature-Agent member, or with one of an unsupported type', async () => {
    const req = signedWba();
    const removed = { ...req, headers: { ...req.headers } } as typeof req;
    delete (removed.headers as Record<string, string>)['Signature-Agent'];
    expect(await verifyWithProfile(removed, wbaOptions(key).options)).toMatchObject({ ok: false, reason: 'signature_agent_missing' });
    const unsupported = { ...req, headers: { ...req.headers, 'Signature-Agent': 'sig1="https://agents.example";type=other' } };
    expect(await verifyWithProfile(unsupported, wbaOptions(key).options)).toMatchObject({ ok: false, reason: 'signature_agent_unsupported' });
  });

  it('denies a key from another Signature-Agent, and a keyid that is not the thumbprint', async () => {
    const req = signedWba();
    const elsewhere = { ...req, headers: { ...req.headers, 'Signature-Agent': 'sig1="https://elsewhere.example"' } };
    expect(await verifyWithProfile(elsewhere, wbaOptions(key).options)).toMatchObject({ ok: false, reason: 'key_unknown' });
    const other = publicJwk(generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }));
    expect(await verifyWithProfile(req, { ...wbaOptions(key).options, resolveKey: () => other })).toMatchObject({ ok: false, reason: 'key_mismatch' });
  });

  it('denies a window over the configured maximum and a replayed nonce', async () => {
    const long = signedWba({ expires: NOW + 7200 });
    expect(await verifyWithProfile(long, wbaOptions(key, { maxWindowSeconds: 3600 }).options)).toMatchObject({ ok: false, reason: 'window_too_long' });
    const req = signedWba();
    const { options } = wbaOptions(key);
    expect((await verifyWithProfile(req, options)).ok).toBe(true);
    expect(await verifyWithProfile(req, options)).toMatchObject({ ok: false, reason: 'nonce_replayed' });
  });

  it('parses and serializes Signature-Agent in Dictionary form, ignoring unsupported members', () => {
    const agents = parseSignatureAgent('a="https://one.example", b="https://two.example";type=cimd, c="http://insecure.example", d=?1, e="https://e.example";type=x');
    expect([...agents.keys()]).toEqual(['a', 'b']);
    expect(agents.get('b')).toEqual({ label: 'b', url: 'https://two.example', type: 'cimd' });
    expect(serializeSignatureAgent([...agents.values()])).toBe('a="https://one.example", b="https://two.example";type=cimd');
  });

  it('builds the same base the verifier rebuilds for an origin-form target', () => {
    const req = signedWba({ components: ['@target-uri', 'signature-agent'] });
    const member = parseDictionary(req.headers['Signature-Input']!).get('sig1');
    if (!member || !('items' in member)) throw new Error('bad input');
    expect(createSignatureBase(req, member)).toContain('"@target-uri": https://merchant.example/v1/checkout?cart=c-1001');
  });
});
