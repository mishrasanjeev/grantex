// SPDX-License-Identifier: Apache-2.0
/**
 * Accredited issuers (registry, PRD Phase 1): the record's validation, the
 * operator key check on the write routes, and the public, minimised read.
 *
 * These run against the SQL mock. The writes, the audit chain, suspension
 * timing and key revocation against a real database are in
 * registry-issuers-postgres.integration.test.ts.
 */
import crypto, { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, sqlMock } from './helpers.js';
import {
  IssuerRecordError,
  MAX_JWKS_BYTES,
  MAX_JWKS_KEYS,
  TRUST_MARK_TYPES,
  effectiveIssuerStatus,
  parseAccreditationRequest,
  parseEntityId,
  parseIssuerJwks,
  parseIssuerPatch,
  parseStatusListBase,
  parseTrustMarks,
  toPublicIssuer,
} from '../src/lib/registry/issuers.js';
import {
  operatorKeyMatches,
  registryOperatorKeys,
  registryOperatorKeysConfigError,
} from '../src/lib/registry/operator-auth.js';

type Jwk = Record<string, unknown>;

function ecKey(kid: string): Jwk {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' };
}

function edKey(kid: string): Jwk {
  const { publicKey } = generateKeyPairSync('ed25519');
  return { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA' };
}

function refusal(fn: () => unknown): IssuerRecordError {
  try {
    fn();
  } catch (err) {
    if (err instanceof IssuerRecordError) return err;
    throw err;
  }
  throw new Error('expected the input to be refused');
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_id: 'https://issuer.example',
    jwks: { keys: [ecKey('issuer-2026-01')] },
    trust_marks: ['urn:grantex:tm:provider.entity', 'urn:grantex:tm:agent.identity'],
    status_list_base: 'https://issuer.example/status/',
    accreditation_evidence_ref: 'accreditation-case-0001',
    ...overrides,
  };
}

describe('entity_id', () => {
  it('accepts an https URL with a host and an optional path', () => {
    expect(parseEntityId('https://issuer.example')).toBe('https://issuer.example');
    expect(parseEntityId('https://issuer.example:8443/tenants/a')).toBe('https://issuer.example:8443/tenants/a');
  });

  it.each([
    ['http scheme', 'http://issuer.example'],
    ['userinfo', 'https://operator@issuer.example'],
    ['user and password', 'https://user:secret@issuer.example'],
    ['a query', 'https://issuer.example/?tenant=a'],
    ['an empty query', 'https://issuer.example/?'],
    ['a fragment', 'https://issuer.example/#top'],
    ['an empty fragment', 'https://issuer.example/#'],
    ['no host', 'https:///path'],
    ['not a URL', 'issuer.example'],
    ['a non-canonical host', 'https://ISSUER.example'],
    // One stored spelling per bare origin, so the UNIQUE constraint holds.
    ['a bare origin with a trailing slash', 'https://issuer.example/'],
    ['a port origin with a trailing slash', 'https://issuer.example:8443/'],
    ['a dot segment', 'https://issuer.example/a/../b'],
    ['surrounding space', ' https://issuer.example'],
    ['a number', 42],
  ])('refuses %s', (_label, value) => {
    const err = refusal(() => parseEntityId(value));
    expect(err.statusCode).toBe(400);
    expect(err.field).toBe('entity_id');
  });

  it('refuses one longer than the bound', () => {
    expect(refusal(() => parseEntityId(`https://issuer.example/${'a'.repeat(2100)}`)).field).toBe('entity_id');
  });
});

describe('status_list_base', () => {
  it('must be an https prefix that ends with a slash', () => {
    expect(parseStatusListBase('https://issuer.example/status/')).toBe('https://issuer.example/status/');
    // Without the slash, https://issuer.example/status would also cover
    // https://issuer.example/status-elsewhere.
    expect(refusal(() => parseStatusListBase('https://issuer.example/status')).field).toBe('status_list_base');
    expect(refusal(() => parseStatusListBase('http://issuer.example/status/')).field).toBe('status_list_base');
    expect(refusal(() => parseStatusListBase('https://issuer.example/status/?x=1')).field).toBe('status_list_base');
  });
});

describe('trust marks', () => {
  it('has exactly the five Phase 1 trust mark types', () => {
    expect([...TRUST_MARK_TYPES].sort()).toEqual([
      'urn:grantex:tm:agent.identity',
      'urn:grantex:tm:agent.security',
      'urn:grantex:tm:provider.entity',
      'urn:grantex:tm:provider.ownership',
      'urn:grantex:tm:provider.screening',
    ]);
  });

  it('accepts marks from the taxonomy', () => {
    expect(parseTrustMarks(['urn:grantex:tm:agent.security'])).toEqual(['urn:grantex:tm:agent.security']);
    expect(parseTrustMarks([])).toEqual([]);
  });

  it.each([
    ['an unknown mark', ['urn:grantex:tm:provider.wealth']],
    ['a mark in the wrong case', ['urn:grantex:tm:Provider.Entity']],
    ['a mark from another namespace', ['https://issuer.example/tm/provider.entity']],
    ['a duplicate', ['urn:grantex:tm:agent.identity', 'urn:grantex:tm:agent.identity']],
    ['a non-string', [7]],
    ['not an array', 'urn:grantex:tm:agent.identity'],
  ])('refuses %s', (_label, value) => {
    const err = refusal(() => parseTrustMarks(value));
    expect(err.field).toBe('trust_marks');
    expect(err.statusCode).toBe(400);
  });
});

describe('issuer JWKS', () => {
  it('accepts EC P-256 (ES256) and OKP Ed25519 (EdDSA) public keys', () => {
    const jwks = parseIssuerJwks({ keys: [ecKey('ec-1'), edKey('ed-1')] });
    expect(jwks.keys.map((key) => key['kid'])).toEqual(['ec-1', 'ed-1']);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(jwks.keys[1]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
  });

  it('refuses a key with private members', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const withD = { ...privateKey.export({ format: 'jwk' }), kid: 'leaked' };
    expect(refusal(() => parseIssuerJwks({ keys: [withD] })).message).toMatch(/private/);
    const { privateKey: edPrivate } = generateKeyPairSync('ed25519');
    const edWithD = { ...edPrivate.export({ format: 'jwk' }), kid: 'leaked-ed' };
    expect(refusal(() => parseIssuerJwks({ keys: [edWithD] })).message).toMatch(/private/);
  });

  it.each([
    ['an RSA key', () => {
      const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      return { ...publicKey.export({ format: 'jwk' }), kid: 'rsa-1' };
    }],
    ['a P-384 key', () => {
      const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
      return { ...publicKey.export({ format: 'jwk' }), kid: 'p384' };
    }],
    ['a symmetric key', () => ({ kty: 'oct', k: randomBytes(32).toString('base64url'), kid: 'oct' })],
    ['an X25519 key', () => {
      const { publicKey } = generateKeyPairSync('x25519');
      return { ...publicKey.export({ format: 'jwk' }), kid: 'x' };
    }],
    ['a key without a kid', () => { const key = ecKey('x'); delete key['kid']; return key; }],
    ['an EC key marked EdDSA', () => ({ ...ecKey('e'), alg: 'EdDSA' })],
    ['an EC key marked ES384', () => ({ ...ecKey('e'), alg: 'ES384' })],
    ['an encryption key', () => ({ ...ecKey('e'), use: 'enc' })],
    ['a key for signing rather than verifying', () => { const key = ecKey('e'); delete key['use']; return { ...key, key_ops: ['sign'] }; }],
    ['a point that is not on the curve', () => ({ ...ecKey('e'), y: Buffer.alloc(32, 1).toString('base64url') })],
    ['a short coordinate', () => ({ ...ecKey('e'), x: Buffer.alloc(31, 1).toString('base64url') })],
    ['an unknown member', () => ({ ...ecKey('e'), x5u: 'https://issuer.example/cert.pem' })],
  ])('refuses %s', (_label, make) => {
    const err = refusal(() => parseIssuerJwks({ keys: [make()] }));
    expect(err.field).toBe('jwks');
  });

  it('refuses duplicate kids', () => {
    expect(refusal(() => parseIssuerJwks({ keys: [ecKey('same'), edKey('same')] })).message).toMatch(/unique/);
  });

  it('refuses an empty set, more than the maximum number of keys and more than the size bound', () => {
    expect(refusal(() => parseIssuerJwks({ keys: [] })).field).toBe('jwks');
    const many = Array.from({ length: MAX_JWKS_KEYS + 1 }, (_v, i) => edKey(`k${i}`));
    expect(refusal(() => parseIssuerJwks({ keys: many })).field).toBe('jwks');
    const padded = { keys: [ecKey('a')], pad: 'x'.repeat(MAX_JWKS_BYTES) };
    expect(refusal(() => parseIssuerJwks(padded)).message).toMatch(/bytes|member/);
    expect(refusal(() => parseIssuerJwks([ecKey('a')])).field).toBe('jwks');
  });

  it('keeps only the public members it knows', () => {
    const key = ecKey('keep');
    const [stored] = parseIssuerJwks({ keys: [key] }).keys;
    expect(Object.keys(stored!).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  });
});

describe('accreditation request', () => {
  it('parses a complete record', () => {
    const parsed = parseAccreditationRequest(validRecord({
      did: 'did:web:issuer.example',
      events_endpoint: 'https://issuer.example/events',
      data_residency: 'EU',
    }));
    expect(parsed).toMatchObject({
      entityId: 'https://issuer.example',
      did: 'did:web:issuer.example',
      trustMarks: ['urn:grantex:tm:provider.entity', 'urn:grantex:tm:agent.identity'],
      statusListBase: 'https://issuer.example/status/',
      eventsEndpoint: 'https://issuer.example/events',
      dataResidency: 'EU',
      accreditationEvidenceRef: 'accreditation-case-0001',
    });
  });

  it('refuses an unknown trust mark, an http entity_id and a missing evidence reference', () => {
    expect(refusal(() => parseAccreditationRequest(validRecord({ trust_marks: ['urn:grantex:tm:x'] }))).field).toBe('trust_marks');
    expect(refusal(() => parseAccreditationRequest(validRecord({ entity_id: 'http://issuer.example' }))).field).toBe('entity_id');
    const noRef = validRecord();
    delete noRef['accreditation_evidence_ref'];
    expect(refusal(() => parseAccreditationRequest(noRef)).field).toBe('accreditation_evidence_ref');
  });

  it('refuses evidence in place of a reference', () => {
    expect(refusal(() => parseAccreditationRequest(validRecord({
      accreditation_evidence_ref: 'certificate of incorporation, page 1 of 3',
    }))).field).toBe('accreditation_evidence_ref');
    expect(refusal(() => parseAccreditationRequest(validRecord({
      accreditation_evidence_ref: { document: 'base64...' },
    }))).field).toBe('accreditation_evidence_ref');
  });

  it('refuses members it does not know, so a typo is not silently dropped', () => {
    expect(refusal(() => parseAccreditationRequest(validRecord({ trustMarks: [] }))).field).toBe('trustMarks');
    expect(refusal(() => parseAccreditationRequest(validRecord({ status: 'suspended' }))).field).toBe('status');
  });
});

describe('issuer patch', () => {
  const now = new Date('2026-09-28T12:00:00Z');

  it('schedules a suspension from effective_from, past or future', () => {
    const future = parseIssuerPatch({ status: 'suspended', effective_from: '2026-09-29T00:00:00Z', reason: 'review' }, now);
    expect(future.status).toEqual({ status: 'suspended', effectiveFrom: new Date('2026-09-29T00:00:00Z') });
    const immediate = parseIssuerPatch({ status: 'suspended', reason: 'review' }, now);
    expect(immediate.status).toEqual({ status: 'suspended', effectiveFrom: now });
  });

  it('takes effective_from only with a suspension', () => {
    expect(refusal(() => parseIssuerPatch({ status: 'active', effective_from: '2026-09-29T00:00:00Z', reason: 'r' }, now)).field)
      .toBe('effective_from');
    expect(refusal(() => parseIssuerPatch({ effective_from: '2026-09-29T00:00:00Z', reason: 'r' }, now)).field)
      .toBe('effective_from');
    expect(refusal(() => parseIssuerPatch({ status: 'suspended', effective_from: 'tomorrow', reason: 'r' }, now)).field)
      .toBe('effective_from');
  });

  it('needs a reason and at least one change', () => {
    expect(refusal(() => parseIssuerPatch({ status: 'withdrawn' }, now)).field).toBe('reason');
    expect(refusal(() => parseIssuerPatch({ reason: 'nothing' }, now)).statusCode).toBe(400);
    expect(refusal(() => parseIssuerPatch({ status: 'paused', reason: 'r' }, now)).field).toBe('status');
  });

  it('revokes kids by name and refuses a kid that is also in a replacement JWKS', () => {
    expect(parseIssuerPatch({ revoke_kids: ['k1'], reason: 'compromised' }, now).revokeKids).toEqual(['k1']);
    expect(refusal(() => parseIssuerPatch({ revoke_kids: [], reason: 'r' }, now)).field).toBe('revoke_kids');
    expect(refusal(() => parseIssuerPatch({
      revoke_kids: ['k1'], jwks: { keys: [ecKey('k1')] }, reason: 'r',
    }, now)).field).toBe('jwks');
  });
});

describe('effective status', () => {
  const at = new Date('2026-09-28T12:00:00Z');
  it('is active until a scheduled suspension takes effect', () => {
    expect(effectiveIssuerStatus({ status: 'active', suspendedEffectiveFrom: null }, at)).toBe('active');
    expect(effectiveIssuerStatus({ status: 'suspended', suspendedEffectiveFrom: new Date('2026-09-28T13:00:00Z') }, at))
      .toBe('active');
    expect(effectiveIssuerStatus({ status: 'suspended', suspendedEffectiveFrom: new Date('2026-09-28T12:00:00Z') }, at))
      .toBe('suspended');
    expect(effectiveIssuerStatus({ status: 'withdrawn', suspendedEffectiveFrom: null }, at)).toBe('withdrawn');
  });

  it('treats a suspension without a start as already in effect', () => {
    expect(effectiveIssuerStatus({ status: 'suspended', suspendedEffectiveFrom: null }, at)).toBe('suspended');
  });
});

describe('operator keys', () => {
  const keyA = randomBytes(32).toString('hex');
  const keyB = randomBytes(32).toString('hex');

  afterEach(() => { vi.restoreAllMocks(); });

  it('reads a comma-separated list and ignores blanks', () => {
    expect(registryOperatorKeys({ REGISTRY_OPERATOR_API_KEYS: ` ${keyA} ,, ${keyB} ` })).toEqual([keyA, keyB]);
    expect(registryOperatorKeys({})).toEqual([]);
  });

  it('treats a configuration with a short key as no configuration at all', () => {
    expect(registryOperatorKeys({ REGISTRY_OPERATOR_API_KEYS: `${keyA},short` })).toEqual([]);
    expect(registryOperatorKeysConfigError(`${keyA},short`)).toMatch(/at least 32/);
    expect(registryOperatorKeysConfigError(`${keyA},${keyB}`)).toBeNull();
    expect(registryOperatorKeysConfigError(undefined)).toBeNull();
    expect(registryOperatorKeysConfigError(`${keyA},${keyA}`)).toMatch(/twice/);
  });

  it('matches any configured key', () => {
    expect(operatorKeyMatches(`Bearer ${keyA}`, [keyA, keyB])).toBe(true);
    expect(operatorKeyMatches(`Bearer ${keyB}`, [keyA, keyB])).toBe(true);
    expect(operatorKeyMatches(`Bearer ${keyB}x`, [keyA, keyB])).toBe(false);
    expect(operatorKeyMatches(keyA, [keyA])).toBe(false);
    expect(operatorKeyMatches(undefined, [keyA])).toBe(false);
    expect(operatorKeyMatches(`Bearer ${keyA}`, [])).toBe(false);
  });

  it('compares against every key in constant time, whatever the presented length', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    for (const presented of [`Bearer ${keyA}`, `Bearer ${keyB}`, 'Bearer x', `Bearer ${'y'.repeat(500)}`, '']) {
      spy.mockClear();
      operatorKeyMatches(presented, [keyA, keyB]);
      // One fixed-length comparison per configured key, no early exit: which
      // key matched, and how long the guess was, do not change the work done.
      expect(spy).toHaveBeenCalledTimes(2);
      for (const [left, right] of spy.mock.calls) {
        expect((left as Buffer).length).toBe(32);
        expect((right as Buffer).length).toBe(32);
      }
    }
  });
});

describe('public record', () => {
  it('carries only the minimised fields and drops revoked kids', () => {
    const k1 = ecKey('k1');
    const k2 = edKey('k2');
    const shown = toPublicIssuer({
      entityId: 'https://issuer.example',
      trustMarks: ['urn:grantex:tm:agent.identity'],
      status: 'active',
      suspendedEffectiveFrom: null,
      statusListBase: 'https://issuer.example/status/',
      jwks: { keys: [k1, k2] as never[] },
      revokedKids: ['k1'],
    }, new Date());
    expect(Object.keys(shown).sort()).toEqual(['entity_id', 'jwks', 'status', 'status_list_base', 'trust_marks']);
    expect(shown.jwks.keys.map((key) => key['kid'])).toEqual(['k2']);
  });

  it('publishes no keys for a withdrawn issuer', () => {
    const shown = toPublicIssuer({
      entityId: 'https://issuer.example',
      trustMarks: [],
      status: 'withdrawn',
      suspendedEffectiveFrom: null,
      statusListBase: 'https://issuer.example/status/',
      jwks: { keys: [ecKey('k1')] as never[] },
      revokedKids: [],
    }, new Date());
    expect(shown.jwks.keys).toEqual([]);
    expect(shown.status).toBe('withdrawn');
  });
});

// --- Routes -------------------------------------------------------------------

let app: FastifyInstance;
const operatorKey = randomBytes(32).toString('hex');

beforeAll(async () => {
  app = await buildTestApp();
});

beforeEach(() => {
  vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', operatorKey);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('operator routes', () => {
  it.each([
    ['POST', '/v1/registry/issuers'],
    ['PATCH', '/v1/registry/issuers/aiss_01'],
  ] as const)('%s %s answers 503 and reads nothing when no operator key is configured', async (method, url) => {
    vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', '');
    sqlMock.mockClear();
    const res = await app.inject({
      method, url, headers: { authorization: `Bearer ${operatorKey}` }, payload: validRecord(), remoteAddress: '192.0.2.10',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('answers 503 when a configured key is too short to be one', async () => {
    vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', `${operatorKey},short`);
    const res = await app.inject({
      method: 'POST', url: '/v1/registry/issuers', headers: { authorization: `Bearer ${operatorKey}` },
      payload: validRecord(), remoteAddress: '192.0.2.11',
    });
    expect(res.statusCode).toBe(503);
  });

  it.each([
    ['no key', undefined],
    ['a wrong key', `Bearer ${randomBytes(32).toString('hex')}`],
    ['the admin key', `Bearer ${process.env['ADMIN_API_KEY'] ?? ''}`],
    ['a developer API key', 'Bearer test-api-key-1234'],
    ['the key without the scheme', operatorKey],
  ])('refuses %s with 401 before reading the body or the database', async (_label, authorization) => {
    sqlMock.mockClear();
    const res = await app.inject({
      method: 'POST', url: '/v1/registry/issuers',
      headers: authorization === undefined ? {} : { authorization },
      payload: validRecord(), remoteAddress: '192.0.2.12',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHORIZED');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('refuses an unknown trust mark with 400 and writes nothing', async () => {
    sqlMock.mockClear();
    const res = await app.inject({
      method: 'POST', url: '/v1/registry/issuers', headers: { authorization: `Bearer ${operatorKey}` },
      payload: validRecord({ trust_marks: ['urn:grantex:tm:provider.entity', 'urn:grantex:tm:provider.wealth'] }),
      remoteAddress: '192.0.2.13',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'BAD_REQUEST', field: 'trust_marks' });
    expect(sqlMock).not.toHaveBeenCalled();
    expect(sqlMock.begin).not.toHaveBeenCalled();
  });

  it('refuses an entity_id that is not https with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/registry/issuers', headers: { authorization: `Bearer ${operatorKey}` },
      payload: validRecord({ entity_id: 'http://issuer.example' }), remoteAddress: '192.0.2.13',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().field).toBe('entity_id');
  });
});

describe('GET /v1/registry/issuers', () => {
  function issuerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'aiss_01',
      entity_id: 'https://issuer.example',
      trust_marks: ['urn:grantex:tm:agent.identity'],
      status: 'active',
      suspended_effective_from: null,
      status_list_base: 'https://issuer.example/status/',
      jwks: { keys: [ecKey('k1'), edKey('k2')] },
      revoked_kids: ['k1'],
      did: 'did:web:issuer.example',
      accreditation_evidence_ref: 'accreditation-case-0001',
      data_residency: 'EU',
      events_endpoint: 'https://issuer.example/events',
      ...overrides,
    };
  }

  it('needs no key and answers the minimised record without revoked kids', async () => {
    vi.stubEnv('REGISTRY_OPERATOR_API_KEYS', '');
    sqlMock.mockResolvedValueOnce([issuerRow()]);
    const res = await app.inject({ method: 'GET', url: '/v1/registry/issuers', remoteAddress: '198.51.100.20' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issuers).toHaveLength(1);
    expect(Object.keys(body.issuers[0]).sort()).toEqual(['entity_id', 'jwks', 'status', 'status_list_base', 'trust_marks']);
    expect(body.issuers[0].jwks.keys.map((key: Jwk) => key['kid'])).toEqual(['k2']);
    expect(res.body).not.toContain('accreditation-case-0001');
    expect(res.body).not.toContain('aiss_01');
  });

  it('shows a suspension only once it is in effect', async () => {
    const later = new Date(Date.now() + 3_600_000);
    const earlier = new Date(Date.now() - 60_000);
    sqlMock.mockResolvedValueOnce([
      issuerRow({ status: 'suspended', suspended_effective_from: later }),
      issuerRow({ entity_id: 'https://provider.example', status: 'suspended', suspended_effective_from: earlier }),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/registry/issuers', remoteAddress: '198.51.100.21' });
    expect(res.json().issuers.map((issuer: { status: string }) => issuer.status)).toEqual(['active', 'suspended']);
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const row = issuerRow();
    sqlMock.mockResolvedValueOnce([row]);
    const first = await app.inject({ method: 'GET', url: '/v1/registry/issuers', remoteAddress: '198.51.100.22' });
    const etag = first.headers['etag'];
    expect(typeof etag).toBe('string');
    // Revalidated on every read, so a revoked key or a suspension is never
    // served from a shared cache.
    expect(first.headers['cache-control']).toBe('no-cache');
    sqlMock.mockResolvedValueOnce([row]);
    const second = await app.inject({
      method: 'GET', url: '/v1/registry/issuers', headers: { 'if-none-match': etag as string }, remoteAddress: '198.51.100.22',
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    sqlMock.mockResolvedValueOnce([issuerRow({ trust_marks: [] })]);
    const changed = await app.inject({
      method: 'GET', url: '/v1/registry/issuers', headers: { 'if-none-match': etag as string }, remoteAddress: '198.51.100.22',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers['etag']).not.toBe(etag);
  });

  it('is rate-limited per client address', async () => {
    const fresh = await buildTestApp();
    try {
      sqlMock.mockResolvedValue([]);
      let last;
      for (let i = 0; i < 61; i += 1) {
        last = await fresh.inject({ method: 'GET', url: '/v1/registry/issuers', remoteAddress: '203.0.113.30' });
      }
      expect(last!.statusCode).toBe(429);
      const other = await fresh.inject({ method: 'GET', url: '/v1/registry/issuers', remoteAddress: '203.0.113.31' });
      expect(other.statusCode).toBe(200);
    } finally {
      sqlMock.mockResolvedValue([]);
      await fresh.close();
    }
  });
});
