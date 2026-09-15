import { describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey, type JSONWebKeySet } from 'jose';
import { EventVerificationError } from '../src/lib/event-bridge/errors.js';
import { validatePublicJwks } from '../src/lib/event-bridge/keys.js';
import { verifySecurityEventToken, type SetSourceConfig } from '../src/lib/event-bridge/set-verify.js';
import {
  computeWebhookSignature,
  parseWebhookEvent,
  verifyWebhookSignature,
} from '../src/lib/event-bridge/webhook-verify.js';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const NOW_S = Math.floor(NOW / 1000);
const EVENT = 'https://schemas.openid.net/secevent/caep/event-type/session-revoked';

const source: SetSourceConfig = {
  id: 'evsrc_01',
  developerId: 'dev_01',
  issuer: 'https://transmitter.example.com',
  audience: 'https://grantex.example.com/v1/event-bridge/ssf/evsrc_01',
  algorithms: ['RS256', 'ES256'],
  maxAgeSeconds: 300,
};

async function keyPair(alg: 'RS256' | 'ES256', kid: string) {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { privateKey: privateKey as CryptoKey, jwks: { keys: [jwk] } as JSONWebKeySet };
}

interface SetOverrides {
  typ?: string;
  alg?: 'RS256' | 'ES256';
  kid?: string;
  claims?: Record<string, unknown>;
  omit?: string[];
}

async function signSet(privateKey: CryptoKey, overrides: SetOverrides = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    iss: source.issuer,
    aud: source.audience,
    iat: NOW_S - 5,
    jti: 'set-0001',
    sub_id: { format: 'opaque', id: 'business:00000001' },
    events: { [EVENT]: { event_timestamp: NOW_S - 10, reason_admin: { en: 'dissolved' } } },
    ...overrides.claims,
  };
  for (const key of overrides.omit ?? []) delete claims[key];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: overrides.alg ?? 'RS256', typ: overrides.typ ?? 'secevent+jwt', kid: overrides.kid ?? 'k1' })
    .sign(privateKey);
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof EventVerificationError) return err.reason;
    throw err;
  }
  return 'accepted';
}

describe('Security Event Token verification', () => {
  it('accepts a SET from the registered transmitter and normalises its events', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const token = await signSet(privateKey);
    const verified = await verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW });
    expect(verified.jti).toBe('set-0001');
    expect(verified.events).toEqual([{
      sourceId: 'evsrc_01',
      sourceKind: 'ssf',
      developerId: 'dev_01',
      eventId: 'set-0001',
      type: EVENT,
      subject: { format: 'opaque', id: 'business:00000001' },
      data: { event_timestamp: NOW_S - 10, reason_admin: { en: 'dissolved' } },
      occurredAt: new Date((NOW_S - 10) * 1000).toISOString(),
    }]);
  });

  it('accepts ES256 and the application/ media type prefix, and reads an event-level subject', async () => {
    const { privateKey, jwks } = await keyPair('ES256', 'k1');
    const token = await signSet(privateKey, {
      alg: 'ES256',
      typ: 'application/secevent+jwt',
      omit: ['sub_id'],
      claims: { aud: ['other', source.audience], events: { [EVENT]: { subject: { business_ref: 'gb:00000001' } } } },
    });
    const verified = await verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW });
    expect(verified.events[0]!.subject).toEqual({ business_ref: 'gb:00000001' });
    expect(verified.events[0]!.occurredAt).toBe(new Date((NOW_S - 5) * 1000).toISOString());
  });

  it('refuses a forged SET signed with a key the transmitter does not publish', async () => {
    const { jwks } = await keyPair('RS256', 'k1');
    const attacker = await keyPair('RS256', 'k1');
    const token = await signSet(attacker.privateKey);
    expect(await reason(verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW })))
      .toBe('signature_invalid');
  });

  it('refuses a tampered payload', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const [header, , signature] = (await signSet(privateKey)).split('.');
    const payload = Buffer.from(JSON.stringify({
      iss: source.issuer, aud: source.audience, iat: NOW_S, jti: 'set-0001', events: { [EVENT]: {} },
      sub_id: { format: 'opaque', id: 'business:00000002' },
    })).toString('base64url');
    expect(await reason(verifySecurityEventToken(`${header}.${payload}.${signature}`, source, createLocalJWKSet(jwks), { now: NOW })))
      .toBe('signature_invalid');
  });

  it('refuses an unknown kid as key_unavailable', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const token = await signSet(privateKey, { kid: 'k2' });
    expect(await reason(verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW })))
      .toBe('key_unavailable');
  });

  it('refuses a wrong audience', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const token = await signSet(privateKey, { claims: { aud: 'https://another-receiver.example.com' } });
    expect(await reason(verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW })))
      .toBe('audience_mismatch');
  });

  it('refuses a wrong issuer', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const token = await signSet(privateKey, { claims: { iss: 'https://impostor.example.com' } });
    expect(await reason(verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW })))
      .toBe('issuer_mismatch');
  });

  it('refuses a token whose typ is not secevent+jwt (a grant token or ID token replayed here)', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    for (const typ of ['JWT', 'at+jwt', 'decision+jwt']) {
      const token = await signSet(privateKey, { typ });
      expect(await reason(verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW })))
        .toBe('unsupported_typ');
    }
  });

  it('refuses an algorithm outside the source allow list, including none and HS256', async () => {
    const { privateKey, jwks } = await keyPair('ES256', 'k1');
    const token = await signSet(privateKey, { alg: 'ES256' });
    expect(await reason(verifySecurityEventToken(token, { ...source, algorithms: ['RS256'] }, createLocalJWKSet(jwks), { now: NOW })))
      .toBe('unsupported_alg');

    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const claims = encode({ iss: source.issuer, aud: source.audience, iat: NOW_S, jti: 'x', events: { [EVENT]: {} } });
    for (const alg of ['none', 'HS256']) {
      const token = `${encode({ alg, typ: 'secevent+jwt' })}.${claims}.${alg === 'none' ? '' : 'c2ln'}`;
      expect(await reason(verifySecurityEventToken(token, source, createLocalJWKSet(jwks), { now: NOW })))
        .toBe('unsupported_alg');
    }
  });

  it('refuses a stale SET and one issued in the future', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const stale = await signSet(privateKey, { claims: { iat: NOW_S - 300 - 61 } });
    expect(await reason(verifySecurityEventToken(stale, source, createLocalJWKSet(jwks), { now: NOW }))).toBe('stale');
    const future = await signSet(privateKey, { claims: { iat: NOW_S + 120 } });
    expect(await reason(verifySecurityEventToken(future, source, createLocalJWKSet(jwks), { now: NOW }))).toBe('iat_in_future');
  });

  it('refuses a SET without iat, jti or events, and an expired one', async () => {
    const { privateKey, jwks } = await keyPair('RS256', 'k1');
    const getKey = createLocalJWKSet(jwks);
    expect(await reason(verifySecurityEventToken(await signSet(privateKey, { omit: ['iat'] }), source, getKey, { now: NOW })))
      .toBe('iat_missing');
    expect(await reason(verifySecurityEventToken(await signSet(privateKey, { omit: ['jti'] }), source, getKey, { now: NOW })))
      .toBe('jti_missing');
    expect(await reason(verifySecurityEventToken(await signSet(privateKey, { omit: ['events'] }), source, getKey, { now: NOW })))
      .toBe('events_missing');
    expect(await reason(verifySecurityEventToken(await signSet(privateKey, { claims: { events: {} } }), source, getKey, { now: NOW })))
      .toBe('events_missing');
    expect(await reason(verifySecurityEventToken(await signSet(privateKey, { claims: { exp: NOW_S - 120 } }), source, getKey, { now: NOW })))
      .toBe('expired');
  });

  it('refuses bodies that are not a compact JWS', async () => {
    const { jwks } = await keyPair('RS256', 'k1');
    for (const body of ['', 'not-a-jwt', 'a.b', '{"events":{}}']) {
      expect(await reason(verifySecurityEventToken(body, source, createLocalJWKSet(jwks), { now: NOW }))).toBe('malformed');
    }
  });

  it('fails closed as key_unavailable when the key resolver throws', async () => {
    const { privateKey } = await keyPair('RS256', 'k1');
    const token = await signSet(privateKey);
    const failing = async () => { throw new Error('network unreachable'); };
    expect(await reason(verifySecurityEventToken(token, source, failing, { now: NOW }))).toBe('key_unavailable');
  });
});

describe('generic signed webhook verification', () => {
  const secret = 'gxevs_placeholder_secret_for_tests_only';
  const body = Buffer.from(JSON.stringify({ id: 'evt_0001', type: 'business.dissolved', subject: { business_ref: 'gb:00000001' } }));
  const timestamp = String(NOW_S);

  it('accepts a signature over the timestamp and raw body', () => {
    expect(() => verifyWebhookSignature({
      rawBody: body, timestamp, signature: computeWebhookSignature(secret, timestamp, body),
      secrets: [secret], toleranceSeconds: 300, now: NOW,
    })).not.toThrow();
  });

  it('refuses a forged signature', () => {
    const forged = computeWebhookSignature('gxevs_attacker_guess', timestamp, body);
    expect(() => verifyWebhookSignature({ rawBody: body, timestamp, signature: forged, secrets: [secret], toleranceSeconds: 300, now: NOW }))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }));
  });

  it('refuses a signature moved to a different body or timestamp', () => {
    const signature = computeWebhookSignature(secret, timestamp, body);
    const altered = Buffer.from(body.toString().replace('00000001', '00000002'));
    expect(() => verifyWebhookSignature({ rawBody: altered, timestamp, signature, secrets: [secret], toleranceSeconds: 300, now: NOW }))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }));
    expect(() => verifyWebhookSignature({ rawBody: body, timestamp: String(NOW_S + 1), signature, secrets: [secret], toleranceSeconds: 300, now: NOW }))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }));
  });

  it('refuses a correctly signed delivery outside the replay window, in either direction', () => {
    for (const ts of [String(NOW_S - 301), String(NOW_S + 301)]) {
      const signature = computeWebhookSignature(secret, ts, body);
      expect(() => verifyWebhookSignature({ rawBody: body, timestamp: ts, signature, secrets: [secret], toleranceSeconds: 300, now: NOW }))
        .toThrowError(expect.objectContaining({ reason: 'timestamp_out_of_window' }));
    }
  });

  it('accepts the previous secret during rotation and any one of several presented signatures', () => {
    const next = 'gxevs_placeholder_next_secret_for_tests';
    const oldSignature = computeWebhookSignature(secret, timestamp, body);
    expect(() => verifyWebhookSignature({ rawBody: body, timestamp, signature: oldSignature, secrets: [next, secret], toleranceSeconds: 300, now: NOW }))
      .not.toThrow();
    const both = `${computeWebhookSignature('gxevs_unknown', timestamp, body)}, ${oldSignature}`;
    expect(() => verifyWebhookSignature({ rawBody: body, timestamp, signature: both, secrets: [secret], toleranceSeconds: 300, now: NOW }))
      .not.toThrow();
    // Once the previous secret has expired it is no longer offered.
    expect(() => verifyWebhookSignature({ rawBody: body, timestamp, signature: oldSignature, secrets: [next], toleranceSeconds: 300, now: NOW }))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }));
  });

  it('refuses missing or malformed headers with distinct reasons', () => {
    const signature = computeWebhookSignature(secret, timestamp, body);
    const base = { rawBody: body, secrets: [secret], toleranceSeconds: 300, now: NOW };
    expect(() => verifyWebhookSignature({ ...base, timestamp: undefined, signature })).toThrowError(expect.objectContaining({ reason: 'timestamp_missing' }));
    expect(() => verifyWebhookSignature({ ...base, timestamp: '2026-09-15', signature })).toThrowError(expect.objectContaining({ reason: 'timestamp_invalid' }));
    expect(() => verifyWebhookSignature({ ...base, timestamp, signature: undefined })).toThrowError(expect.objectContaining({ reason: 'signature_missing' }));
    expect(() => verifyWebhookSignature({ ...base, timestamp, signature: 'v1=abc' })).toThrowError(expect.objectContaining({ reason: 'signature_invalid' }));
    expect(() => verifyWebhookSignature({ ...base, secrets: [], timestamp, signature })).toThrowError(expect.objectContaining({ reason: 'secret_unavailable' }));
  });

  it('parses an authenticated body into a normalised event and refuses malformed ones', () => {
    expect(parseWebhookEvent(Buffer.from(JSON.stringify({
      id: 'evt_0001', type: 'business.dissolved', subject: { business_ref: 'gb:00000001' },
      data: { status: 'dissolved' }, occurred_at: '2026-09-15T11:59:00Z',
    })), { id: 'evsrc_02', developerId: 'dev_01' })).toEqual({
      sourceId: 'evsrc_02', sourceKind: 'webhook', developerId: 'dev_01', eventId: 'evt_0001',
      type: 'business.dissolved', subject: { business_ref: 'gb:00000001' }, data: { status: 'dissolved' },
      occurredAt: '2026-09-15T11:59:00.000Z',
    });
    const ref = { id: 'evsrc_02', developerId: 'dev_01' };
    expect(() => parseWebhookEvent(Buffer.from('not json'), ref)).toThrowError(expect.objectContaining({ reason: 'malformed' }));
    expect(() => parseWebhookEvent(Buffer.from('[]'), ref)).toThrowError(expect.objectContaining({ reason: 'malformed' }));
    expect(() => parseWebhookEvent(Buffer.from('{"type":"x"}'), ref)).toThrowError(expect.objectContaining({ reason: 'jti_missing' }));
    expect(() => parseWebhookEvent(Buffer.from('{"id":"e"}'), ref)).toThrowError(expect.objectContaining({ reason: 'events_missing' }));
    expect(() => parseWebhookEvent(Buffer.from('{"id":"e","type":"x","subject":"gb:1"}'), ref)).toThrowError(expect.objectContaining({ reason: 'malformed' }));
  });
});

describe('transmitter JWK Set validation', () => {
  it('accepts public keys and refuses private or symmetric key material', async () => {
    const { jwks } = await keyPair('ES256', 'k1');
    expect(validatePublicJwks(jwks)).toEqual(jwks);
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    expect(() => validatePublicJwks({ keys: [privateJwk] })).toThrow(/public keys only/);
    expect(() => validatePublicJwks({ keys: [{ kty: 'oct', k: 'c2VjcmV0' }] })).toThrow(/RSA, EC or OKP/);
    expect(() => validatePublicJwks({ keys: [] })).toThrow(/1 to 20/);
    expect(() => validatePublicJwks([])).toThrow(/keys array/);
  });
});
