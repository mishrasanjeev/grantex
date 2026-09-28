// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's attestation-acceptance status lists over HTTP.
 *
 * GET /status/attestations/:list serves a Token Status List token
 * (draft-ietf-oauth-status-list-21 §5.1, §8.2); /bitstring and
 * /bitstring/suspension serve Bitstring Status List credentials (W3C
 * Bitstring Status List v1.0 §2.2) secured as VC-JWTs (W3C VC-JOSE-COSE
 * §3.1.1). Every one of them is signed with the platform signing key and
 * verifies against the published JWK Set.
 *
 * The SQL mock stands in for the store; the store itself is exercised
 * against real Postgres in registry-acceptance-postgres.integration.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';
import {
  ACCEPTANCE_STATUS_RATE_LIMIT_PER_MINUTE,
  CASCADE_TTL_SECONDS,
  CASCADE_WINDOW_SECONDS,
  NORMAL_TTL_SECONDS,
  acceptanceListUri,
  acceptanceTtlSeconds,
  resetAcceptanceStatusCache,
} from '../src/lib/registry/acceptance-status.js';
import {
  ACCEPTANCE_LIST_CAPACITY,
  decodeBitstringStatusList,
  decodeTokenStatusList,
} from '../src/lib/registry/status-list-codec.js';

const LIST_ID = 'racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const BASE = 'https://grantex.dev';

interface ListRow {
  id: string;
  capacity: number;
  version: number;
  updated_at: Date;
  cascade_at: Date | null;
}

let app: FastifyInstance;
let list: ListRow | null;
let entries: Array<{ idx: number; status: number }>;
let failQueries = false;
let queries: string[];
let ipCounter = 0;
let ip: string;

function installSql(): void {
  sqlMock.mockImplementation(async (strings: TemplateStringsArray | string) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    queries.push(text);
    if (failQueries && text.includes('registry_acceptance')) throw new Error('connection terminated');
    // Entries are read in one statement with the version they belong to.
    if (text.includes('registry_acceptance_entries')) {
      if (!list) return [];
      const head = { version: list.version, updated_at: list.updated_at };
      return entries.length === 0
        ? [{ ...head, idx: null, status: null }]
        : entries.map((entry) => ({ ...head, ...entry }));
    }
    if (text.includes('FROM registry_acceptance_lists')) return list ? [{ ...list }] : [];
    return [];
  });
}

async function jwks(): Promise<ReturnType<typeof createLocalJWKSet>> {
  const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  expect(res.statusCode).toBe(200);
  return createLocalJWKSet(res.json());
}

function get(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url, headers, remoteAddress: ip });
}

// The public routes are registered only while REGISTRY_PUBLIC_ENDPOINTS_ENABLED
// is exactly 'true' at boot; the flag-off app is exercised at the end.
const FLAG = 'REGISTRY_PUBLIC_ENDPOINTS_ENABLED';
const savedFlag = process.env[FLAG];

beforeAll(async () => {
  process.env[FLAG] = 'true';
  app = await buildTestApp();
});

afterAll(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

beforeEach(() => {
  resetAcceptanceStatusCache();
  queries = [];
  failQueries = false;
  // A documentation-range address per test, so route rate limits never collide.
  ipCounter += 1;
  ip = `198.51.100.${ipCounter}`;
  list = {
    id: LIST_ID,
    capacity: ACCEPTANCE_LIST_CAPACITY,
    version: 3,
    updated_at: new Date(Date.now() - 2 * 3600_000),
    cascade_at: new Date(Date.now() - 2 * 3600_000),
  };
  entries = [
    { idx: 5, status: 1 },
    { idx: 77_001, status: 2 },
    { idx: 131_071, status: 1 },
  ];
  installSql();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('acceptanceTtlSeconds (owner decision 9)', () => {
  const now = new Date('2026-09-28T12:00:00Z');

  it('is 600 s with no acceptance change on record', () => {
    expect(NORMAL_TTL_SECONDS).toBe(600);
    expect(acceptanceTtlSeconds(now, null)).toBe(600);
  });

  it('is 60 s for one hour after an acceptance change or suspension', () => {
    expect(CASCADE_TTL_SECONDS).toBe(60);
    expect(CASCADE_WINDOW_SECONDS).toBe(3600);
    expect(acceptanceTtlSeconds(now, new Date(now.getTime() - 1_000))).toBe(60);
    expect(acceptanceTtlSeconds(now, new Date(now.getTime() - 3_599_000))).toBe(60);
  });

  it('returns to 600 s once the hour has passed', () => {
    expect(acceptanceTtlSeconds(now, new Date(now.getTime() - 3_600_000))).toBe(600);
    expect(acceptanceTtlSeconds(now, new Date(now.getTime() - 86_400_000))).toBe(600);
  });

  it('treats a change stamped after now (clock skew between instances) as inside the window', () => {
    expect(acceptanceTtlSeconds(now, new Date(now.getTime() + 5_000))).toBe(60);
  });
});

describe('GET /status/attestations/:list (Token Status List)', () => {
  it('serves a statuslist+jwt signed with a key from the published JWK Set', async () => {
    const res = await get(`/status/attestations/${LIST_ID}`);
    expect(res.statusCode).toBe(200);
    // draft-ietf-oauth-status-list-21 §8.2
    expect(res.headers['content-type']).toBe('application/statuslist+jwt');

    const token = res.body;
    const header = decodeProtectedHeader(token);
    expect(header.typ).toBe('statuslist+jwt');
    expect(typeof header.kid).toBe('string');

    const { payload } = await jwtVerify(token, await jwks(), { typ: 'statuslist+jwt', issuer: BASE });
    expect(payload.sub).toBe(`${BASE}/status/attestations/${LIST_ID}`);
    expect(payload.sub).toBe(acceptanceListUri(LIST_ID));
    expect(typeof payload.iat).toBe('number');
    expect(payload.exp).toBeGreaterThan(payload.iat!);
    expect(payload['ttl']).toBe(600);

    const statusList = payload['status_list'] as { bits: 1 | 2 | 4 | 8; lst: string };
    expect(statusList.bits).toBe(2);
    const decoded = decodeTokenStatusList(statusList);
    expect(decoded.size).toBe(ACCEPTANCE_LIST_CAPACITY);
    expect(decoded.statusAt(5)).toBe(1);
    expect(decoded.statusAt(77_001)).toBe(2);
    expect(decoded.statusAt(131_071)).toBe(1);
    expect(decoded.statusAt(6)).toBe(0);
  });

  it('never states an iat earlier than the list change it reflects', async () => {
    list!.updated_at = new Date(Date.now() - 1_500);
    const res = await get(`/status/attestations/${LIST_ID}`);
    const { payload } = await jwtVerify(res.body, await jwks());
    expect(payload.iat! * 1000).toBeGreaterThanOrEqual(Math.floor(list!.updated_at.getTime() / 1000) * 1000);
    expect(payload.iat! * 1000).toBeLessThanOrEqual(Date.now());
  });

  it('switches ttl to 60 s and Cache-Control to max-age=60 inside a cascade window', async () => {
    list!.cascade_at = new Date(Date.now() - 10 * 60_000);
    const res = await get(`/status/attestations/${LIST_ID}`);
    expect(res.statusCode).toBe(200);
    const { payload } = await jwtVerify(res.body, await jwks());
    expect(payload['ttl']).toBe(60);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
  });

  it('caches for the ttl outside a cascade window', async () => {
    const res = await get(`/status/attestations/${LIST_ID}`);
    expect(res.headers['cache-control']).toBe('public, max-age=600');
  });

  it('answers If-None-Match with 304 while the list is unchanged, and 200 once it changes', async () => {
    const first = await get(`/status/attestations/${LIST_ID}`);
    const etag = first.headers['etag'] as string;
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);

    const again = await get(`/status/attestations/${LIST_ID}`, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers['etag']).toBe(etag);
    expect(again.headers['cache-control']).toBe('public, max-age=600');

    const listOf = await get(`/status/attestations/${LIST_ID}`, { 'if-none-match': `W/"other", ${etag}` });
    expect(listOf.statusCode).toBe(304);
    const star = await get(`/status/attestations/${LIST_ID}`, { 'if-none-match': '*' });
    expect(star.statusCode).toBe(304);

    // A different validator is a full response with the same tag.
    const other = await get(`/status/attestations/${LIST_ID}`, { 'if-none-match': 'W/"stale"' });
    expect(other.statusCode).toBe(200);
    expect(other.headers['etag']).toBe(etag);

    // An acceptance change bumps the version: new content, new tag.
    list!.version += 1;
    list!.updated_at = new Date();
    list!.cascade_at = new Date();
    entries = [...entries, { idx: 6, status: 2 }];
    const changed = await get(`/status/attestations/${LIST_ID}`, { 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers['etag']).not.toBe(etag);
    const { payload } = await jwtVerify(changed.body, await jwks());
    expect(decodeTokenStatusList(payload['status_list'] as { bits: 2; lst: string }).statusAt(6)).toBe(2);
    expect(payload['ttl']).toBe(60);
  });

  it('keeps the same token and tag across requests for one version', async () => {
    const first = await get(`/status/attestations/${LIST_ID}`);
    const second = await get(`/status/attestations/${LIST_ID}`);
    expect(second.body).toBe(first.body);
    expect(second.headers['etag']).toBe(first.headers['etag']);
    // The entries of an unchanged version are read once.
    expect(queries.filter((q) => q.includes('registry_acceptance_entries'))).toHaveLength(1);
  });

  it('is public, and readable from a browser on any origin (§8.1 CORS)', async () => {
    const res = await get(`/status/attestations/${LIST_ID}`, { origin: 'https://verifier.example' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers 404 for an unknown list and for a malformed list id, without reading entries', async () => {
    list = null;
    const unknown = await get(`/status/attestations/${LIST_ID}`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('NOT_FOUND');

    queries = [];
    const malformed = await get('/status/attestations/..%2Fetc');
    expect(malformed.statusCode).toBe(404);
    expect(queries.filter((q) => q.includes('registry_acceptance'))).toHaveLength(0);
    expect(queries.filter((q) => q.includes('registry_acceptance_entries'))).toHaveLength(0);
  });

  it('fails closed with a 5xx, never a stale list, when the store cannot be read', async () => {
    const ok = await get(`/status/attestations/${LIST_ID}`);
    expect(ok.statusCode).toBe(200);
    failQueries = true;
    const res = await get(`/status/attestations/${LIST_ID}`);
    expect(res.statusCode).toBe(500);
    expect(res.headers['content-type']).not.toBe('application/statuslist+jwt');
  });

  it('is rate-limited per client', async () => {
    const url = `/status/attestations/${LIST_ID}`;
    for (let i = 0; i < ACCEPTANCE_STATUS_RATE_LIMIT_PER_MINUTE; i++) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
    }
    const limited = await get(url);
    expect(limited.statusCode).toBe(429);
    // Another client still gets through.
    const other = await app.inject({ method: 'GET', url, remoteAddress: '203.0.113.200' });
    expect(other.statusCode).toBe(200);
  });
});

describe('GET /status/attestations/:list/bitstring (Bitstring Status List)', () => {
  async function verified(url: string): Promise<{ payload: JWTPayload; headers: Record<string, unknown> }> {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    // W3C VC-JOSE-COSE §3.1.1 and §6.1.1
    expect(res.headers['content-type']).toBe('application/vc+jwt');
    const header = decodeProtectedHeader(res.body);
    expect(header.typ).toBe('vc+jwt');
    expect(header.cty).toBe('vc');
    const { payload } = await jwtVerify(res.body, await jwks(), { typ: 'vc+jwt' });
    return { payload, headers: res.headers };
  }

  it('serves a signed BitstringStatusListCredential for revocation', async () => {
    const { payload, headers } = await verified(`/status/attestations/${LIST_ID}/bitstring`);
    const uri = `${BASE}/status/attestations/${LIST_ID}/bitstring`;
    expect(payload['@context']).toEqual(['https://www.w3.org/ns/credentials/v2']);
    expect(payload['id']).toBe(uri);
    expect(payload['type']).toEqual(['VerifiableCredential', 'BitstringStatusListCredential']);
    expect(payload['issuer']).toBe(BASE);
    // VC-JOSE-COSE §3.1.1: the vc claim must not be present.
    expect(payload['vc']).toBeUndefined();
    expect(new Date(payload['validFrom'] as string).getTime()).toBe(payload.iat! * 1000);
    expect(new Date(payload['validUntil'] as string).getTime()).toBe(payload.exp! * 1000);

    const subject = payload['credentialSubject'] as Record<string, unknown>;
    expect(subject['id']).toBe(`${uri}#list`);
    expect(subject['type']).toBe('BitstringStatusList');
    expect(subject['statusPurpose']).toBe('revocation');
    // ttl in milliseconds (Bitstring Status List §2.2), aligned with Cache-Control.
    expect(subject['ttl']).toBe(600_000);
    expect(headers['cache-control']).toBe('public, max-age=600');

    const bits = decodeBitstringStatusList(subject['encodedList'] as string);
    expect(bits.length).toBe(ACCEPTANCE_LIST_CAPACITY);
    expect(bits.isSet(5)).toBe(true);
    expect(bits.isSet(131_071)).toBe(true);
    // Suspended is not revoked.
    expect(bits.isSet(77_001)).toBe(false);
    expect(bits.isSet(6)).toBe(false);
  });

  it('serves the suspension purpose from the same entries', async () => {
    const { payload } = await verified(`/status/attestations/${LIST_ID}/bitstring/suspension`);
    expect(payload['id']).toBe(`${BASE}/status/attestations/${LIST_ID}/bitstring/suspension`);
    const subject = payload['credentialSubject'] as Record<string, unknown>;
    expect(subject['statusPurpose']).toBe('suspension');
    const bits = decodeBitstringStatusList(subject['encodedList'] as string);
    expect(bits.isSet(77_001)).toBe(true);
    expect(bits.isSet(5)).toBe(false);
    expect(bits.isSet(131_071)).toBe(false);
  });

  it('switches ttl to 60,000 ms inside a cascade window', async () => {
    list!.cascade_at = new Date(Date.now() - 59 * 60_000);
    const { payload, headers } = await verified(`/status/attestations/${LIST_ID}/bitstring`);
    expect((payload['credentialSubject'] as Record<string, unknown>)['ttl']).toBe(60_000);
    expect(headers['cache-control']).toBe('public, max-age=60');
  });

  it('answers If-None-Match with 304, and gives each purpose its own tag', async () => {
    const revocation = await get(`/status/attestations/${LIST_ID}/bitstring`);
    const suspension = await get(`/status/attestations/${LIST_ID}/bitstring/suspension`);
    const tsl = await get(`/status/attestations/${LIST_ID}`);
    const tags = new Set([revocation.headers['etag'], suspension.headers['etag'], tsl.headers['etag']]);
    expect(tags.size).toBe(3);

    const again = await get(`/status/attestations/${LIST_ID}/bitstring`, {
      'if-none-match': revocation.headers['etag'] as string,
    });
    expect(again.statusCode).toBe(304);
  });

  it('answers 404 for an unknown list or purpose', async () => {
    expect((await get(`/status/attestations/${LIST_ID}/bitstring/refresh`)).statusCode).toBe(404);
    list = null;
    expect((await get(`/status/attestations/${LIST_ID}/bitstring`)).statusCode).toBe(404);
  });
});

describe('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', () => {
  const paths = [
    `/status/attestations/${LIST_ID}`,
    `/status/attestations/${LIST_ID}/bitstring`,
    `/status/attestations/${LIST_ID}/bitstring/suspension`,
  ];

  async function appWithFlag(value: string | undefined): Promise<FastifyInstance> {
    if (value === undefined) delete process.env[FLAG];
    else process.env[FLAG] = value;
    try {
      return await buildTestApp();
    } finally {
      process.env[FLAG] = 'true';
    }
  }

  for (const value of [undefined, 'false', 'TRUE', '1', 'yes', ' true']) {
    it(`does not register the public routes when the flag is ${JSON.stringify(value)}`, async () => {
      const off = await appWithFlag(value);
      try {
        for (const url of paths) {
          // Not registered: exactly the answer a path that was never a route
          // gets. Without credentials that is the auth hook's 401; with them,
          // the 404 of an unknown route.
          const res = await off.inject({ method: 'GET', url, remoteAddress: ip });
          const unknown = await off.inject({ method: 'GET', url: '/status/no-such-route', remoteAddress: ip });
          expect(res.statusCode).toBe(unknown.statusCode);
          expect(res.json().code).toBe(unknown.json().code);
          expect(res.headers['content-type']).not.toMatch(/jwt/);
          seedAuth();
          const authed = await off.inject({ method: 'GET', url, remoteAddress: ip, headers: authHeader() });
          expect(authed.statusCode).toBe(404);
          const preflightTo = (target: string) => off.inject({
            method: 'OPTIONS',
            url: target,
            remoteAddress: ip,
            headers: {
              origin: 'https://verifier.example',
              'access-control-request-method': 'GET',
              'access-control-request-headers': 'if-none-match',
            },
          });
          const preflight = await preflightTo(url);
          const unknownPreflight = await preflightTo('/status/no-such-route');
          // No CORS grant for an origin outside CORS_ALLOWED_ORIGINS, so a
          // browser cannot read these paths cross-origin while the flag is off.
          expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
          expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
          expect(preflight.statusCode).toBe(unknownPreflight.statusCode);
        }
        expect(queries.filter((q) => q.includes('registry_acceptance'))).toHaveLength(0);
      } finally {
        await off.close();
      }
    });
  }

  it('serves every public route when the flag is exactly "true"', async () => {
    const on = await appWithFlag('true');
    try {
      for (const url of paths) {
        const res = await on.inject({ method: 'GET', url, remoteAddress: ip });
        expect(res.statusCode).toBe(200);
      }
    } finally {
      await on.close();
    }
  });
});

describe('CORS for conditional requests from a browser relying party', () => {
  const paths = [
    `/status/attestations/${LIST_ID}`,
    `/status/attestations/${LIST_ID}/bitstring`,
    `/status/attestations/${LIST_ID}/bitstring/suspension`,
  ];

  function preflight(url: string, origin = 'https://verifier.example') {
    return app.inject({
      method: 'OPTIONS',
      url,
      remoteAddress: ip,
      headers: {
        origin,
        'access-control-request-method': 'GET',
        // If-None-Match is not a CORS-safelisted request-header, so a browser
        // sends a preflight naming it (lower-cased) before the GET.
        'access-control-request-headers': 'if-none-match',
      },
    });
  }

  it('answers the preflight for an origin outside CORS_ALLOWED_ORIGINS', async () => {
    for (const url of paths) {
      const res = await preflight(url);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(String(res.headers['access-control-allow-methods']).split(/\s*,\s*/)).toContain('GET');
      expect(String(res.headers['access-control-allow-headers']).toLowerCase().split(/\s*,\s*/))
        .toContain('if-none-match');
      expect(queries.filter((q) => q.includes('registry_acceptance'))).toHaveLength(0);
    }
  });

  it('refuses an OPTIONS request that is not a CORS preflight', async () => {
    const res = await app.inject({ method: 'OPTIONS', url: paths[0]!, remoteAddress: ip });
    expect(res.statusCode).toBe(400);
    expect(res.headers['access-control-allow-headers']).toBeUndefined();
  });

  it('allows only GET, and no credentials, from any origin', async () => {
    const res = await preflight(paths[0]!, 'https://dashboard.example');
    const methods = String(res.headers['access-control-allow-methods']).split(/\s*,\s*/);
    expect(methods).toEqual(['GET']);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('exposes ETag on 200 and 304 so the relying party can revalidate', async () => {
    for (const url of paths) {
      const first = await get(url, { origin: 'https://verifier.example' });
      expect(first.statusCode).toBe(200);
      expect(first.headers['access-control-allow-origin']).toBe('*');
      expect(String(first.headers['access-control-expose-headers']).toLowerCase().split(/\s*,\s*/))
        .toContain('etag');
      const again = await get(url, {
        origin: 'https://verifier.example',
        'if-none-match': first.headers['etag'] as string,
      });
      expect(again.statusCode).toBe(304);
      expect(again.headers['access-control-allow-origin']).toBe('*');
      expect(again.headers['access-control-allow-credentials']).toBeUndefined();
      expect(String(again.headers['access-control-expose-headers']).toLowerCase().split(/\s*,\s*/))
        .toContain('etag');
    }
  });
});
