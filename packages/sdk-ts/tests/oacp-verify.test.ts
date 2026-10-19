/**
 * verifyOacpArtifact against the shared OACP vectors
 * (spec/examples/oacp/oacp-artifact-jws-v1.json) and Token Status List
 * tokens built here with keys generated for the test.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  canonicalize,
  createOacpJwksFetcher,
  createOacpStatusListFetcher,
  decodeOacpStatusList,
  verifyOacpArtifact,
  type OacpJwks,
} from '../src/index.js';

interface VectorCase { name: string; envelope: Record<string, unknown>; payload: Record<string, unknown>; expect: string }
interface Vectors {
  verify_at: string;
  jwks: OacpJwks;
  test_private_jwk: Record<string, string>;
  payload_canonical: string;
  payload_hash: string;
  signing_payload_canonical: string;
  status_list: { uri: string; idx: number };
  cases: VectorCase[];
}

const VECTORS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'oacp', 'oacp-artifact-jws-v1.json'),
  'utf-8',
)) as Vectors;
const ISSUER = 'https://issuer.example';
const NOW = new Date(VECTORS.verify_at);
const NOW_S = Math.floor(NOW.getTime() / 1000);
const valid = VECTORS.cases.find((c) => c.name === 'valid')!;

const b64u = (value: string | Buffer) => Buffer.from(value).toString('base64url');

// Status lists are signed with a key generated for this run, published beside the vector keys.
const statusKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const statusJwk = { ...statusKey.publicKey.export({ format: 'jwk' }), kid: 'status-test-es', alg: 'ES256', use: 'sig' };
const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsaJwk = { ...rsaKey.publicKey.export({ format: 'jwk' }), kid: 'status-test-rs', alg: 'RS256', use: 'sig' };
const strangerKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const JWKS: OacpJwks = { keys: [...VECTORS.jwks.keys, statusJwk, rsaJwk] };

function lst(statuses: Record<number, number>, size = 64, bits = 2): string {
  const perByte = 8 / bits;
  const bytes = Buffer.alloc(Math.ceil(size / perByte));
  for (const [idx, status] of Object.entries(statuses)) {
    const i = Number(idx);
    bytes[Math.floor(i / perByte)]! |= status << ((i % perByte) * bits);
  }
  return deflateSync(bytes).toString('base64url');
}

function statusToken(
  status: number,
  overrides: { claims?: Record<string, unknown>; header?: Record<string, unknown>; key?: KeyObject; alg?: 'ES256' | 'RS256' } = {},
): string {
  const alg = overrides.alg ?? 'ES256';
  const header = { alg, kid: alg === 'ES256' ? 'status-test-es' : 'status-test-rs', typ: 'statuslist+jwt', ...overrides.header };
  const claims = {
    iss: ISSUER,
    sub: VECTORS.status_list.uri,
    iat: NOW_S - 60,
    exp: NOW_S + 3600,
    ttl: 600,
    status_list: { bits: 2, lst: lst({ [VECTORS.status_list.idx]: status }) },
    ...overrides.claims,
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const key = overrides.key ?? (alg === 'ES256' ? statusKey.privateKey : rsaKey.privateKey);
  const signature = alg === 'ES256'
    ? sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    : sign('sha256', Buffer.from(input), key);
  return `${input}.${b64u(signature)}`;
}

const base = { issuer: ISSUER, jwks: JWKS, now: NOW };

describe('OACP vectors', () => {
  it('canonicalises the payload and the signing input as the vectors do', () => {
    expect(canonicalize(valid.payload)).toBe(VECTORS.payload_canonical);
    const { signature: _signature, ...unsigned } = valid.envelope;
    expect(canonicalize(unsigned)).toBe(VECTORS.signing_payload_canonical);
  });

  for (const vector of VECTORS.cases) {
    it(`${vector.name} -> ${vector.expect}`, async () => {
      const result = await verifyOacpArtifact(vector.envelope, vector.payload, { ...base, checkStatus: false });
      if (vector.expect === 'valid') {
        expect(result).toMatchObject({ valid: true, status: 'not_checked', payloadHash: VECTORS.payload_hash });
      } else {
        expect(result).toMatchObject({ valid: false, refusalCode: vector.expect });
      }
    });
  }
});

describe('verifyOacpArtifact checks after the signature', () => {
  it('refuses an artifact naming another issuer', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, issuer: 'https://other.example', checkStatus: false });
    expect(result).toMatchObject({ valid: false, refusalCode: 'issuer_key_untrusted' });
  });

  it('refuses when the JWK Set holds the kid twice', async () => {
    const duplicated = { keys: [...JWKS.keys, VECTORS.jwks.keys[0]!] };
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, jwks: duplicated, checkStatus: false });
    expect(result).toMatchObject({ valid: false, refusalCode: 'issuer_key_untrusted' });
  });

  it('refuses a key published for another use', async () => {
    const keys = JWKS.keys.map((k) => (k['kid'] === 'oacp-test-2026-10-a' ? { ...k, use: 'enc' } : k));
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, jwks: { keys }, checkStatus: false });
    expect(result).toMatchObject({ valid: false, refusalCode: 'issuer_key_untrusted' });
  });

  it('refetches a JWK Set source once for an unknown kid', async () => {
    const calls: Array<boolean | undefined> = [];
    const source = async (options?: { refresh?: boolean }) => {
      calls.push(options?.refresh);
      return options?.refresh ? JWKS : { keys: [] };
    };
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, jwks: source, checkStatus: false });
    expect(result.valid).toBe(true);
    expect(calls).toEqual([undefined, true]);
  });

  it('refuses when the JWK Set cannot be loaded', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, {
      ...base, jwks: async () => { throw new Error('offline'); }, checkStatus: false,
    });
    expect(result).toMatchObject({ valid: false, refusalCode: 'issuer_key_untrusted' });
  });

  it('refuses an expired artifact', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, now: new Date('2026-10-19T16:00:01.000Z'), checkStatus: false });
    expect(result).toMatchObject({ valid: false, refusalCode: 'artifact_expired_or_stale' });
  });

  it('applies a stricter TTL override', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, maxTtlSeconds: { catalog_snapshot: 60 }, checkStatus: false });
    expect(result).toMatchObject({ valid: false, refusalCode: 'artifact_ttl_exceeds_default' });
  });

  it('compares each scope member given, including an empty buyer', async () => {
    const ok = await verifyOacpArtifact(valid.envelope, valid.payload, {
      ...base, checkStatus: false, expectedScope: { tenant_id: 'cten_TEST01', merchant_id: 'mch_TEST01', buyer_agent_id: '' },
    });
    expect(ok.valid).toBe(true);
    const other = await verifyOacpArtifact(valid.envelope, valid.payload, {
      ...base, checkStatus: false, expectedScope: { seller_agent_id: 'seller_OTHER' },
    });
    expect(other).toMatchObject({ valid: false, refusalCode: 'artifact_scope_mismatch' });
  });

  it('refuses non-object inputs', async () => {
    expect(await verifyOacpArtifact(null, valid.payload, base)).toMatchObject({ refusalCode: 'artifact_missing_or_invalid' });
    expect(await verifyOacpArtifact(valid.envelope, [], base)).toMatchObject({ refusalCode: 'artifact_missing_or_invalid' });
  });
});

describe('Token Status List check', () => {
  const withList = (token: string | (() => Promise<string>)) => ({
    ...base,
    statusListFetcher: async (uri: string) => {
      expect(uri).toBe(VECTORS.status_list.uri);
      return typeof token === 'string' ? token : token();
    },
  });

  it('accepts a VALID entry', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(statusToken(0)));
    expect(result).toMatchObject({ valid: true, status: 'valid', artifactId: 'oacp_art_01TESTCATALOG' });
  });

  it('accepts a list signed with an RS256 platform key from the same JWK Set', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(statusToken(0, { alg: 'RS256' })));
    expect(result).toMatchObject({ valid: true, status: 'valid' });
  });

  it('refuses an INVALID entry as revoked', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(statusToken(1)));
    expect(result).toMatchObject({ valid: false, refusalCode: 'artifact_revoked' });
  });

  it('refuses a SUSPENDED entry as suspended', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(statusToken(2)));
    expect(result).toMatchObject({ valid: false, refusalCode: 'artifact_suspended' });
  });

  it('fails closed on an unknown status value', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(statusToken(3)));
    expect(result).toMatchObject({ valid: false, refusalCode: 'revocation_status_unavailable' });
  });

  it('fails closed when the list is unreachable', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(async () => { throw new Error('ECONNREFUSED'); }));
    expect(result).toMatchObject({ valid: false, refusalCode: 'revocation_status_unavailable' });
  });

  it('fails closed without a status list fetcher', async () => {
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, base);
    expect(result).toMatchObject({ valid: false, refusalCode: 'revocation_status_unavailable' });
  });

  const broken: Array<[string, () => string]> = [
    ['signed by a key outside the JWK Set', () => statusToken(0, { key: strangerKey.privateKey })],
    ['for another list', () => statusToken(0, { claims: { sub: 'https://issuer.example/status/oacp/lst_OTHER' } })],
    ['from another issuer', () => statusToken(0, { claims: { iss: 'https://other.example' } })],
    ['expired', () => statusToken(0, { claims: { exp: NOW_S - 1 } })],
    ['without exp or ttl', () => statusToken(0, { claims: { exp: undefined, ttl: undefined } })],
    ['issued in the future', () => statusToken(0, { claims: { iat: NOW_S + 3600, exp: NOW_S + 7200 } })],
    ['with the wrong typ', () => statusToken(0, { header: { typ: 'JWT' } })],
    ['too short for the index', () => statusToken(0, { claims: { status_list: { bits: 2, lst: lst({}, 4) } } })],
    ['with a bad bit width', () => statusToken(0, { claims: { status_list: { bits: 3, lst: lst({}) } } })],
    ['not ZLIB data', () => statusToken(0, { claims: { status_list: { bits: 2, lst: b64u('not zlib') } } })],
    ['not a JWS', () => 'not-a-jws'],
  ];
  for (const [label, token] of broken) {
    it(`fails closed on a list ${label}`, async () => {
      const result = await verifyOacpArtifact(valid.envelope, valid.payload, withList(token()));
      expect(result).toMatchObject({ valid: false, refusalCode: 'revocation_status_unavailable' });
    });
  }

  it('catches an edited status reference with the signature, before the status check', async () => {
    const envelope = { ...valid.envelope, revocation_status_url: 'https://issuer.example/status/oacp/lst_OTHER' };
    const result = await verifyOacpArtifact(envelope, valid.payload, withList(statusToken(0)));
    // The edit breaks the signature first: tampering is caught before the status check.
    expect(result).toMatchObject({ valid: false, refusalCode: 'detached_jws_verification_failed' });
  });
});

describe('decodeOacpStatusList', () => {
  it('reads entries from the least significant bits of each byte', () => {
    const list = decodeOacpStatusList({ bits: 2, lst: lst({ 0: 1, 1: 2, 5: 1 }, 8) });
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => list.statusAt(i))).toEqual([1, 2, 0, 0, 0, 1, 0, 0]);
    expect(() => list.statusAt(8)).toThrow();
  });

  it('matches the draft-ietf-oauth-status-list 1-bit example', () => {
    // §4.1 example: statuses 1,0,0,1,1,1,0,1 / 1,1,0,0,0,1,0,1 -> bytes 0xB9 0xA3.
    const list = decodeOacpStatusList({ bits: 1, lst: deflateSync(Buffer.from([0xb9, 0xa3])).toString('base64url') });
    expect(Array.from({ length: 16 }, (_, i) => list.statusAt(i))).toEqual([1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1]);
  });
});

describe('fetchers', () => {
  const response = (body: string, init: { status?: number; type?: string } = {}) =>
    new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'application/statuslist+jwt' } });

  it('status list fetcher refuses URIs outside the pinned prefixes and plain http', async () => {
    const fetcher = createOacpStatusListFetcher({ allowedPrefixes: ['https://issuer.example/status/oacp/'], fetch: async () => response('x') });
    await expect(fetcher('https://attacker.example/status/oacp/lst_01TEST')).rejects.toThrow(/outside/);
    await expect(fetcher('http://issuer.example/status/oacp/lst_01TEST')).rejects.toThrow(/https/);
    await expect(fetcher('https://issuer.example/status/oacp/lst_01TEST?x=1')).rejects.toThrow(/query/);
  });

  it('status list fetcher requires 200 and the statuslist+jwt media type', async () => {
    const redirect = createOacpStatusListFetcher({ allowedPrefixes: ['https://issuer.example/status/oacp/'], fetch: async () => response('', { status: 302 }) });
    await expect(redirect(VECTORS.status_list.uri)).rejects.toThrow(/302/);
    const json = createOacpStatusListFetcher({ allowedPrefixes: ['https://issuer.example/status/oacp/'], fetch: async () => response('{}', { type: 'application/json' }) });
    await expect(json(VECTORS.status_list.uri)).rejects.toThrow(/content type/);
  });

  it('status list fetcher reuses a list for its ttl and clear() drops it', async () => {
    let calls = 0;
    const token = statusToken(0, { claims: { exp: Math.floor(Date.now() / 1000) + 3600 } });
    const fetcher = createOacpStatusListFetcher({
      allowedPrefixes: ['https://issuer.example/status/oacp/'],
      fetch: async (_url, init) => {
        calls += 1;
        expect(init?.redirect).toBe('manual');
        return response(token);
      },
    });
    await fetcher(VECTORS.status_list.uri);
    await fetcher(VECTORS.status_list.uri);
    expect(calls).toBe(1);
    fetcher.clear();
    await fetcher(VECTORS.status_list.uri);
    expect(calls).toBe(2);
  });

  it('JWKS fetcher reads the pinned issuer JWKS URI and caches it', async () => {
    const urls: string[] = [];
    const jwks = createOacpJwksFetcher({
      issuer: ISSUER,
      fetch: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify(JWKS), { headers: { 'content-type': 'application/json' } });
      },
    });
    const result = await verifyOacpArtifact(valid.envelope, valid.payload, { ...base, jwks, checkStatus: false });
    expect(result.valid).toBe(true);
    await jwks();
    expect(urls).toEqual(['https://issuer.example/.well-known/jwks.json']);
  });

  it('JWKS fetcher refuses an http issuer unless loopback http is allowed', () => {
    expect(() => createOacpJwksFetcher({ issuer: 'http://issuer.example' })).toThrow(/https/);
    expect(() => createOacpJwksFetcher({ issuer: 'http://127.0.0.1:3001', allowLoopbackHttp: true })).not.toThrow();
  });
});
