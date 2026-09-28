// SPDX-License-Identifier: Apache-2.0
/**
 * The attestation JWS profile (spec/attestation-1.0.md), without a database:
 * compact parsing, the protected header, the payload members and their types,
 * the hash rule, the times, the status list URI rule, the key rule for agent
 * attestations, the issuer's Token Status List check, the signed withdrawal
 * and refresh requests, and the level and flag computation.
 */
import { createHash } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ATTESTATION_REQUEST_TYP,
  ATTESTATION_TYP,
  AttestationError,
  ISSUER_STATUS_MAX_FRESHNESS_SECONDS,
  checkAttestationHeader,
  checkAttestationTimes,
  checkExternalCredentialHash,
  evaluateAttestationKey,
  parseAttestationPayload,
  parseCompactJws,
  readIssuerAndType,
  readStatusListEntry,
  statusUriUnderBase,
  verifyAttestationRequest,
  verifyJwsSignature,
  verifyStatusListToken,
} from '../src/lib/registry/attestation-jws.js';
import {
  ATTESTATION_EXPIRING_WINDOW_SECONDS,
  TRUST_FLAGS,
  TRUST_LEVELS,
  combineTrustLevel,
  issuerIndependentOfProvider,
} from '../src/lib/registry/trust-level.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const ISS = 'https://issuer.example';
const STATUS_URI = 'https://issuer.example/status/1';
const HASH = `sha-256:${createHash('sha256').update('issuer-signed-jwt').digest('base64url')}`;

let issuerKey: { privateKey: CryptoKey; jwk: JWK };
let otherKey: { privateKey: CryptoKey; jwk: JWK };

async function es256(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return { privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256' } };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISS,
    id: 'att-0001',
    sub: 'did:web:provider.example:agents:shopper-01',
    type: 'urn:grantex:tm:agent.identity',
    iat: NOW_S - 60,
    exp: NOW_S + 90 * 86_400,
    key_thumbprint: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
    external_credential_id: 'case-0001',
    external_credential_hash: HASH,
    level: 'substantial',
    declared_limits: { max_amount: '250.00', currency: 'EUR' },
    status: { status_list: { uri: STATUS_URI, idx: 7 } },
    ...overrides,
  };
}

async function sign(
  body: unknown,
  header: Record<string, unknown> = { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1' },
  key: CryptoKey = issuerKey.privateKey,
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(body)))
    .setProtectedHeader(header as never)
    .sign(key);
}

function refusal(fn: () => unknown): AttestationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AttestationError);
    return err as AttestationError;
  }
  throw new Error('expected a refusal');
}

async function refusalAsync(promise: Promise<unknown>): Promise<AttestationError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AttestationError);
  return err as AttestationError;
}

/** A Token Status List (draft-ietf-oauth-status-list-21 §4.1) of 2-bit entries. */
function lst(entries: Record<number, number>, size = 64): string {
  const bytes = Buffer.alloc(size / 4);
  for (const [idx, value] of Object.entries(entries)) {
    const i = Number(idx);
    bytes[Math.floor(i / 4)]! |= value << ((i % 4) * 2);
  }
  return deflateSync(bytes).toString('base64url');
}

async function statusListToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { typ: 'statuslist+jwt', alg: 'ES256', kid: 'k1' },
  key: CryptoKey = issuerKey.privateKey,
): Promise<string> {
  return sign({
    sub: STATUS_URI,
    iat: NOW_S - 30,
    exp: NOW_S + 3600,
    ttl: 300,
    status_list: { bits: 2, lst: lst({ 7: 0, 8: 1, 9: 2 }) },
    ...claims,
  }, header, key);
}

beforeAll(async () => {
  issuerKey = await es256('k1');
  otherKey = await es256('k2');
});

describe('compact JWS parsing', () => {
  it('reads a compact JWS into its header and payload', async () => {
    const parsed = parseCompactJws(await sign(payload()));
    expect(parsed.header).toEqual({ typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1' });
    expect(parsed.payload['id']).toBe('att-0001');
  });

  it.each([
    ['empty', ''],
    ['two parts', 'eyJhbGciOiJFUzI1NiJ9.e30'],
    ['four parts', 'a.b.c.d'],
    ['a JSON serialization', '{"payload":"e30"}'],
    ['non-base64url characters', 'eyJ+.e30.c2ln'],
    ['a header that is not JSON', `${Buffer.from('nope').toString('base64url')}.e30.c2ln`],
    ['a payload that is an array', `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from('[]').toString('base64url')}.c2ln`],
    ['an empty signature', `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.e30.`],
  ])('refuses %s as attestation_malformed', (_name, value) => {
    expect(refusal(() => parseCompactJws(value)).code).toBe('attestation_malformed');
  });

  it('refuses something that is not a string', () => {
    expect(refusal(() => parseCompactJws({} as never)).code).toBe('attestation_malformed');
  });
});

describe('protected header', () => {
  it('accepts typ grantex-attestation+jwt, ES256 and a kid', () => {
    expect(checkAttestationHeader({ typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1' }, { eddsaEnabled: false }))
      .toEqual({ alg: 'ES256', kid: 'k1' });
  });

  it.each([
    ['a missing typ', { alg: 'ES256', kid: 'k1' }, 'wrong_typ'],
    ['typ JWT', { typ: 'JWT', alg: 'ES256', kid: 'k1' }, 'wrong_typ'],
    ['the full media type', { typ: 'application/grantex-attestation+jwt', alg: 'ES256', kid: 'k1' }, 'wrong_typ'],
    ['a typ in another case', { typ: 'Grantex-Attestation+JWT', alg: 'ES256', kid: 'k1' }, 'wrong_typ'],
    ['alg none', { typ: ATTESTATION_TYP, alg: 'none', kid: 'k1' }, 'alg_not_allowed'],
    ['alg RS256', { typ: ATTESTATION_TYP, alg: 'RS256', kid: 'k1' }, 'alg_not_allowed'],
    ['alg HS256', { typ: ATTESTATION_TYP, alg: 'HS256', kid: 'k1' }, 'alg_not_allowed'],
    ['EdDSA while it is off', { typ: ATTESTATION_TYP, alg: 'EdDSA', kid: 'k1' }, 'alg_not_allowed'],
    ['no kid', { typ: ATTESTATION_TYP, alg: 'ES256' }, 'kid_missing'],
    ['an empty kid', { typ: ATTESTATION_TYP, alg: 'ES256', kid: '' }, 'kid_missing'],
    ['a jku', { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1', jku: 'https://issuer.example/jwks' }, 'header_key_not_allowed'],
    ['a jwk', { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1', jwk: {} }, 'header_key_not_allowed'],
    ['an x5u', { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1', x5u: 'https://issuer.example/x5u' }, 'header_key_not_allowed'],
    ['an x5c', { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1', x5c: [] }, 'header_key_not_allowed'],
    ['crit', { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1', crit: ['exp'] }, 'crit_not_supported'],
  ])('refuses %s', (_name, header, reason) => {
    const err = refusal(() => checkAttestationHeader(header, { eddsaEnabled: false }));
    expect(err.code).toBe('attestation_malformed');
    expect(err.reason).toBe(reason);
  });

  it('accepts EdDSA only when it is turned on', () => {
    expect(checkAttestationHeader({ typ: ATTESTATION_TYP, alg: 'EdDSA', kid: 'k1' }, { eddsaEnabled: true }))
      .toEqual({ alg: 'EdDSA', kid: 'k1' });
  });
});

describe('issuer and type', () => {
  it('reads iss and type before anything else in the payload', () => {
    expect(readIssuerAndType({ iss: ISS, type: 'urn:grantex:tm:provider.entity' }))
      .toEqual({ iss: ISS, type: 'urn:grantex:tm:provider.entity' });
  });

  it.each([
    ['no iss', { type: 'urn:grantex:tm:provider.entity' }],
    ['a numeric iss', { iss: 7, type: 'urn:grantex:tm:provider.entity' }],
    ['no type', { iss: ISS }],
    ['a type array', { iss: ISS, type: ['urn:grantex:tm:provider.entity'] }],
  ])('refuses %s as attestation_malformed', (_name, body) => {
    expect(refusal(() => readIssuerAndType(body)).code).toBe('attestation_malformed');
  });
});

describe('signature', () => {
  it('verifies with the issuer key named by kid', async () => {
    await expect(verifyJwsSignature(await sign(payload()), issuerKey.jwk, 'ES256')).resolves.toBeUndefined();
  });

  it('refuses a signature by another key with passport_invalid_signature', async () => {
    const err = await refusalAsync(verifyJwsSignature(await sign(payload(), undefined, otherKey.privateKey), issuerKey.jwk, 'ES256'));
    expect(err.code).toBe('passport_invalid_signature');
  });

  it('refuses a payload changed after signing', async () => {
    const [h, , s] = (await sign(payload())).split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify(payload({ level: 'high' }))).toString('base64url')}.${s}`;
    expect((await refusalAsync(verifyJwsSignature(forged, issuerKey.jwk, 'ES256'))).code).toBe('passport_invalid_signature');
  });

  it('refuses when there is no key', async () => {
    expect((await refusalAsync(verifyJwsSignature(await sign(payload()), null, 'ES256'))).code).toBe('passport_invalid_signature');
  });
});

describe('payload (Appendix A)', () => {
  it('reads every member of an agent attestation', () => {
    const claims = parseAttestationPayload(payload());
    expect(claims).toEqual({
      iss: ISS,
      id: 'att-0001',
      sub: 'did:web:provider.example:agents:shopper-01',
      type: 'urn:grantex:tm:agent.identity',
      subjectKind: 'agent',
      iat: NOW_S - 60,
      exp: NOW_S + 90 * 86_400,
      keyThumbprint: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
      externalCredentialId: 'case-0001',
      externalCredentialHash: HASH,
      level: 'substantial',
      declaredLimits: { max_amount: '250.00', currency: 'EUR' },
      statusListUri: STATUS_URI,
      statusListIdx: 7,
    });
  });

  it('reads a provider attestation, which has no key', () => {
    const { key_thumbprint: _unused, declared_limits: _limits, ...rest } = payload({
      sub: 'did:web:provider.example', type: 'urn:grantex:tm:provider.entity',
    });
    const claims = parseAttestationPayload(rest);
    expect(claims.subjectKind).toBe('provider');
    expect(claims.keyThumbprint).toBeNull();
    expect(claims.declaredLimits).toBeNull();
  });

  it('keeps level verbatim', () => {
    expect(parseAttestationPayload(payload({ level: 'LoA 3 (eIDAS high)' })).level).toBe('LoA 3 (eIDAS high)');
  });

  const withoutKey = (() => {
    const { key_thumbprint: _unused, ...rest } = payload();
    return rest;
  })();

  it.each([
    ['an unknown member', payload({ nbf: NOW_S }), 'unknown_member'],
    ['a member the profile does not define for issuers to add', payload({ provider_screening: 'hit' }), 'unknown_member'],
    ['a missing id', { ...payload(), id: undefined }, 'bad_claim'],
    ['an id with a space', payload({ id: 'att 1' }), 'bad_claim'],
    ['an id of 129 characters', payload({ id: 'a'.repeat(129) }), 'bad_claim'],
    ['a sub that is not a DID', payload({ sub: 'https://provider.example' }), 'bad_claim'],
    ['a type outside the taxonomy', payload({ type: 'urn:grantex:tm:agent.other' }), 'bad_claim'],
    ['an iat that is a string', payload({ iat: String(NOW_S) }), 'bad_claim'],
    ['an iat with a fraction', payload({ iat: NOW_S + 0.5 }), 'bad_claim'],
    ['a missing exp', { ...payload(), exp: undefined }, 'bad_claim'],
    ['an agent attestation without key_thumbprint', withoutKey, 'bad_claim'],
    ['a key_thumbprint that is not a SHA-256 thumbprint', payload({ key_thumbprint: 'abc' }), 'bad_claim'],
    ['a provider attestation with a key_thumbprint', payload({ type: 'urn:grantex:tm:provider.entity' }), 'bad_claim'],
    ['an empty external_credential_id', payload({ external_credential_id: '' }), 'bad_claim'],
    ['a numeric external_credential_hash', payload({ external_credential_hash: 7 }), 'bad_claim'],
    ['an empty level', payload({ level: '' }), 'bad_claim'],
    ['a numeric level', payload({ level: 3 }), 'bad_claim'],
    ['declared_limits that is an array', payload({ declared_limits: [] }), 'bad_claim'],
    ['declared_limits that is null', payload({ declared_limits: null }), 'bad_claim'],
    ['a status without status_list', payload({ status: {} }), 'bad_claim'],
    ['a status_list without idx', payload({ status: { status_list: { uri: STATUS_URI } } }), 'bad_claim'],
    ['a negative idx', payload({ status: { status_list: { uri: STATUS_URI, idx: -1 } } }), 'bad_claim'],
    ['an http status list uri', payload({ status: { status_list: { uri: 'http://issuer.example/status/1', idx: 1 } } }), 'bad_claim'],
    ['an extra status member', payload({ status: { status_list: { uri: STATUS_URI, idx: 1 }, other: 1 } }), 'bad_claim'],
  ])('refuses %s as attestation_malformed', (_name, body, reason) => {
    const clean = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    const err = refusal(() => parseAttestationPayload(clean));
    expect(err.code).toBe('attestation_malformed');
    expect(err.reason).toBe(reason);
  });
});

describe('hash rule', () => {
  it('accepts sha-256: and 43 base64url characters', () => {
    expect(() => checkExternalCredentialHash(HASH)).not.toThrow();
  });

  it.each([
    ['no prefix', HASH.slice('sha-256:'.length)],
    ['another algorithm', HASH.replace('sha-256:', 'sha-512:')],
    ['an upper-case prefix', HASH.replace('sha-256:', 'SHA-256:')],
    ['padding', `${HASH}=`],
    ['base64 rather than base64url', `sha-256:${'+'.repeat(43)}`],
    ['42 characters', HASH.slice(0, -1)],
    ['44 characters', `${HASH}A`],
    ['hex', `sha-256:${'ab'.repeat(32)}`],
  ])('refuses %s with attestation_hash_mismatch', (_name, value) => {
    expect(refusal(() => checkExternalCredentialHash(value)).code).toBe('attestation_hash_mismatch');
  });
});

describe('times', () => {
  it('accepts an unexpired attestation issued before now', () => {
    expect(() => checkAttestationTimes({ iat: NOW_S - 60, exp: NOW_S + 60 }, NOW)).not.toThrow();
  });

  it.each([
    ['exp now', { iat: NOW_S - 60, exp: NOW_S }, 'expired'],
    ['exp in the past', { iat: NOW_S - 120, exp: NOW_S - 60 }, 'expired'],
    ['exp before iat', { iat: NOW_S + 10, exp: NOW_S + 5 }, 'exp_not_after_iat'],
    ['exp equal to iat', { iat: NOW_S, exp: NOW_S }, 'exp_not_after_iat'],
    ['iat more than a minute ahead', { iat: NOW_S + 120, exp: NOW_S + 3600 }, 'not_yet_valid'],
  ])('refuses %s with passport_expired', (_name, times, reason) => {
    const err = refusal(() => checkAttestationTimes(times, NOW));
    expect(err.code).toBe('passport_expired');
    expect(err.reason).toBe(reason);
  });
});

describe('status list URI under status_list_base (owner decision 8)', () => {
  it.each([
    ['https://issuer.example/status/1', 'https://issuer.example/status/', true],
    ['https://issuer.example/status/a/b', 'https://issuer.example/status/', true],
    ['https://issuer.example/status-other/1', 'https://issuer.example/status/', false],
    ['https://issuer.example/status/', 'https://issuer.example/status/', false],
    ['https://issuer.example.evil.example/status/1', 'https://issuer.example/status/', false],
    ['https://issuer.example/status/../other/1', 'https://issuer.example/status/', false],
    ['https://issuer.example/status/1?x=1', 'https://issuer.example/status/', false],
    ['https://issuer.example/status/1#f', 'https://issuer.example/status/', false],
  ])('%s under %s: %s', (uri, base, expected) => {
    expect(statusUriUnderBase(uri, base)).toBe(expected);
  });
});

describe('the key an agent attestation names (possession before attestation)', () => {
  const at = NOW;
  const proved = new Date(NOW.getTime() - 3_600_000);
  it.each([
    ['active and proven', { status: 'active', possessionProvedAt: proved, validFrom: proved, validTo: null }, null],
    ['pending and proven', { status: 'pending', possessionProvedAt: proved, validFrom: proved, validTo: null }, null],
    ['rotated inside its overlap', { status: 'rotated', possessionProvedAt: proved, validFrom: proved, validTo: new Date(NOW.getTime() + 60_000) }, null],
    ['pending and never proven', { status: 'pending', possessionProvedAt: null, validFrom: proved, validTo: null }, 'key_unproven'],
    ['compromised', { status: 'compromised', possessionProvedAt: proved, validFrom: proved, validTo: proved }, 'key_not_active'],
    ['rotated past its overlap', { status: 'rotated', possessionProvedAt: proved, validFrom: proved, validTo: NOW }, 'key_not_active'],
    ['an unknown status', { status: 'retired', possessionProvedAt: proved, validFrom: proved, validTo: null }, 'key_not_active'],
  ])('%s', (_name, key, denial) => {
    const result = evaluateAttestationKey(key as never, at);
    expect(result).toEqual(denial === null ? { usable: true } : { usable: false, denial });
  });

  it('refuses a key that is not in the agent\'s history as key_unproven', () => {
    expect(evaluateAttestationKey(null, at)).toEqual({ usable: false, denial: 'key_unproven' });
  });
});

describe('the issuer\'s Token Status List', () => {
  const resolveKey = async (kid: string) => (kid === 'k1' ? issuerKey.jwk : null);
  const check = (token: string, idx = 7) =>
    verifyStatusListToken(token, { uri: STATUS_URI, idx, now: NOW, resolveKey, eddsaEnabled: false });

  it('accepts a fresh list signed by the issuer that shows the entry VALID', async () => {
    await expect(check(await statusListToken())).resolves.toEqual({ freshUntil: new Date((NOW_S + 300) * 1000) });
  });

  it('reports how long the read stays fresh: the earliest of exp, the time of reading plus ttl (§13.7) and the registry cap', async () => {
    const fresh = async (claims: Record<string, unknown>) => (await check(await statusListToken(claims))).freshUntil.getTime() / 1000;
    expect(await fresh({ exp: NOW_S + 100 })).toBe(NOW_S + 100);
    expect(await fresh({ exp: undefined, ttl: 600 })).toBe(NOW_S + 600);
    expect(await fresh({ exp: NOW_S + 365 * 86_400, ttl: undefined })).toBe(NOW_S + ISSUER_STATUS_MAX_FRESHNESS_SECONDS);
    expect(ISSUER_STATUS_MAX_FRESHNESS_SECONDS).toBe(86_400);
  });

  it('reads a revoked or suspended entry with its freshness, for the recheck', async () => {
    const token = await statusListToken();
    const read = (idx: number) => readStatusListEntry(token, { uri: STATUS_URI, idx, now: NOW, resolveKey, eddsaEnabled: false });
    await expect(read(8)).resolves.toEqual({ value: 1, freshUntil: new Date((NOW_S + 300) * 1000) });
    await expect(read(9)).resolves.toEqual({ value: 2, freshUntil: new Date((NOW_S + 300) * 1000) });
  });

  it('refuses INVALID and SUSPENDED entries with passport_revoked', async () => {
    const token = await statusListToken();
    const invalid = await refusalAsync(check(token, 8));
    expect([invalid.code, invalid.reason]).toEqual(['passport_revoked', 'invalid']);
    const suspended = await refusalAsync(check(token, 9));
    expect([suspended.code, suspended.reason]).toEqual(['passport_revoked', 'suspended']);
  });

  it.each([
    ['typ JWT', {}, { typ: 'JWT', alg: 'ES256', kid: 'k1' }, 'wrong_typ'],
    ['no kid', {}, { typ: 'statuslist+jwt', alg: 'ES256' }, 'kid_missing'],
    ['a key the issuer does not have', {}, { typ: 'statuslist+jwt', alg: 'ES256', kid: 'k9' }, 'signature'],
    ['a sub other than the uri', { sub: 'https://issuer.example/status/2' }, undefined, 'sub_mismatch'],
    ['an exp in the past', { exp: NOW_S - 1 }, undefined, 'expired'],
    ['no exp and a ttl that has run out', { exp: undefined, iat: NOW_S - 600, ttl: 300 }, undefined, 'expired'],
    ['neither exp nor ttl', { exp: undefined, ttl: undefined }, undefined, 'no_freshness'],
    ['an iat in the future', { iat: NOW_S + 600 }, undefined, 'not_yet_valid'],
    ['no status_list', { status_list: undefined }, undefined, 'bad_claim'],
    ['a list too short for the index', { status_list: { bits: 2, lst: lst({}, 4) } }, undefined, 'index_out_of_range'],
    ['a list that is not ZLIB', { status_list: { bits: 2, lst: 'AAAA' } }, undefined, 'bad_claim'],
  ])('refuses %s with status_stale', async (_name, claims, header, reason) => {
    const token = await statusListToken(claims as Record<string, unknown>, header as never);
    const err = await refusalAsync(check(token));
    expect(err.code).toBe('status_stale');
    expect(err.reason).toBe(reason);
  });

  it('refuses a list signed by a key outside the issuer\'s set', async () => {
    const token = await statusListToken({}, undefined, otherKey.privateKey);
    const err = await refusalAsync(check(token));
    expect([err.code, err.reason]).toEqual(['status_stale', 'signature']);
  });

  it('refuses something that is not a JWS', async () => {
    expect((await refusalAsync(check('not a token'))).code).toBe('status_stale');
  });
});

describe('signed withdrawal and refresh requests', () => {
  const resolveKey = async (iss: string, kid: string) => (iss === ISS && kid === 'k1' ? issuerKey.jwk : null);
  const AUD = 'https://grantex.dev';
  function request(overrides: Record<string, unknown> = {}) {
    return { iss: ISS, aud: AUD, id: 'att-0001', action: 'withdraw', iat: NOW_S - 5, nonce: 'n0nce-0123456789abcdef', ...overrides };
  }
  const header = { typ: ATTESTATION_REQUEST_TYP, alg: 'ES256', kid: 'k1' };
  const verify = (token: string, action: 'withdraw' | 'refresh' = 'withdraw') =>
    verifyAttestationRequest(token, { action, audience: AUD, now: NOW, resolveKey, eddsaEnabled: false });

  it('accepts a request signed by the issuer for this registry', async () => {
    await expect(verify(await sign(request(), header))).resolves.toEqual({
      iss: ISS, id: 'att-0001', nonce: 'n0nce-0123456789abcdef', iat: NOW_S - 5,
    });
  });

  it.each([
    ['the attestation typ', request(), { typ: ATTESTATION_TYP, alg: 'ES256', kid: 'k1' }, 'request_signature_invalid'],
    ['a refresh used to withdraw', request({ action: 'refresh' }), header, 'request_signature_invalid'],
    ['another audience', request({ aud: 'https://registry.example' }), header, 'audience_mismatch'],
    ['an iat six minutes old', request({ iat: NOW_S - 360 }), header, 'request_signature_stale'],
    ['an iat two minutes ahead', request({ iat: NOW_S + 120 }), header, 'request_signature_stale'],
    ['a short nonce', request({ nonce: 'abc' }), header, 'request_signature_invalid'],
    ['an unknown member', request({ exp: NOW_S + 60 }), header, 'request_signature_invalid'],
    ['an unknown kid', request(), { ...header, kid: 'k9' }, 'request_signature_invalid'],
  ])('refuses %s', async (_name, body, h, code) => {
    expect((await refusalAsync(verify(await sign(body, h)))).code).toBe(code);
  });

  it('refuses a request signed by another key', async () => {
    const token = await sign(request(), header, otherKey.privateKey);
    expect((await refusalAsync(verify(token))).code).toBe('request_signature_invalid');
  });
});

describe('levels and flags (§5.1)', () => {
  it('has exactly the four levels and the enumerated flags', () => {
    expect([...TRUST_LEVELS]).toEqual(['basic', 'verified', 'attested', 'attested_verified']);
    expect([...TRUST_FLAGS]).toEqual([
      'key_compromised', 'attestation_expiring', 'issuer_suspended', 'declared_limits_changed',
      'provider_screening_hit', 'ownership_unresolved', 'security_review_failed',
    ]);
  });

  it('calls an attestation expiring thirty days before exp', () => {
    expect(ATTESTATION_EXPIRING_WINDOW_SECONDS).toBe(30 * 86_400);
  });

  it.each([
    [false, false, false, 'basic'],
    [true, false, false, 'verified'],
    [false, true, false, 'attested'],
    [true, true, false, 'attested_verified'],
    [true, true, true, 'basic'],
    [true, false, true, 'basic'],
  ])('verified %s, attested %s, suspended %s: %s', (verified, attested, suspended, level) => {
    expect(combineTrustLevel({ verified, attested, suspended })).toBe(level);
  });

  it.each([
    ['https://issuer.example', null, 'did:web:provider.example', 'provider.example', true],
    ['https://provider.example', null, 'did:web:provider.example', 'provider.example', false],
    ['https://kyb.provider.example', null, 'did:web:provider.example', 'provider.example', false],
    ['https://issuer.example', 'did:web:provider.example', 'did:web:provider.example', 'provider.example', false],
    ['https://PROVIDER.example', null, 'did:web:provider.example', 'Provider.Example', false],
    ['https://issuer.example/tenants/provider.example', null, 'did:web:provider.example', 'provider.example', true],
  ])('issuer %s (did %s) and provider %s (%s): independent %s', (entityId, did, providerDid, domain, expected) => {
    expect(issuerIndependentOfProvider({ entityId, did }, { organizationDid: providerDid, domain })).toBe(expected);
  });
});
