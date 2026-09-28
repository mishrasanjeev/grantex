// SPDX-License-Identifier: Apache-2.0
/**
 * The signed registry manifest (/.well-known/agent-registry.json) without a
 * database: what signRegistryManifest publishes, and every refusal of
 * verifyRegistryManifest (typ, algorithm, signature, foreign key headers,
 * exp, the one-hour staleness bound, iat in the future, the issuer). The
 * manifest built from a real store, and the routes against it, are covered
 * in registry-lookup-postgres.integration.test.ts; the flag's effect on
 * route registration is covered here with the SQL mock.
 */
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getKeyPair } from '../src/lib/crypto.js';
import { TRUST_MARK_TYPES, type PublicIssuer } from '../src/lib/registry/issuers.js';
import {
  REGISTRY_MANIFEST_ISSUE_INTERVAL_SECONDS,
  REGISTRY_MANIFEST_LIFETIME_SECONDS,
  REGISTRY_MANIFEST_MAX_AGE_SECONDS,
  REGISTRY_MANIFEST_PATH,
  REGISTRY_MANIFEST_TYP,
  RegistryManifestError,
  signRegistryManifest,
  verifyRegistryManifest,
  type RegistryManifestContent,
} from '../src/lib/registry/manifest.js';
import { LOOKUP_RATE_LIMIT_PER_MINUTE } from '../src/lib/registry/lookup.js';
import { buildTestApp, sqlMock } from './helpers.js';

const NOW = new Date('2026-09-28T12:07:30Z');
/** The registry a relying party trusts: the service's JWT_ISSUER in tests. */
const REGISTRY = { issuer: 'https://grantex.dev' };
const ISSUER: PublicIssuer = {
  entity_id: 'https://issuer.example',
  trust_marks: ['urn:grantex:tm:agent.identity'],
  status: 'suspended',
  status_list_base: 'https://issuer.example/status/',
  jwks: { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'issuer-2026-01' }] },
};
const CONTENT: RegistryManifestContent = {
  issuers: [ISSUER],
  acceptanceListIds: ['racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3'],
  lastChange: new Date('2026-09-28T11:00:00Z'),
};

let jwks: { keys: JWK[] };

beforeAll(async () => {
  const app = await buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
  jwks = res.json<{ keys: JWK[] }>();
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A token over `claims` with the platform key, header overridable. */
async function platformSigned(claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const { privateKey, kid, alg } = getKeyPair();
  return new SignJWT(claims).setProtectedHeader({ alg, kid, typ: REGISTRY_MANIFEST_TYP, ...header } as never).sign(privateKey);
}

async function refusal(promise: Promise<unknown>): Promise<RegistryManifestError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(RegistryManifestError);
  return err as RegistryManifestError;
}

describe('signRegistryManifest', () => {
  it('publishes the issuers, the taxonomy, the acceptance lists and the endpoints for one hour', async () => {
    const signed = await signRegistryManifest(CONTENT, NOW);
    const claims = signed.claims;
    expect(claims.iss).toBe('https://grantex.dev');
    // iat is aligned down to the issue interval, and never before the last change.
    expect(claims.iat % REGISTRY_MANIFEST_ISSUE_INTERVAL_SECONDS).toBe(0);
    expect(claims.iat).toBeLessThanOrEqual(Math.floor(NOW.getTime() / 1000));
    expect(claims.exp).toBe(claims.iat + REGISTRY_MANIFEST_LIFETIME_SECONDS);
    expect(claims.issuers).toEqual([ISSUER]);
    expect(claims.trust_mark_types).toEqual([...TRUST_MARK_TYPES]);
    const list = 'https://grantex.dev/status/attestations/racl_01J8Z3K4M5N6P7Q8R9S0T1V2W3';
    expect(claims.acceptance_status_lists).toEqual([{
      token_status_list: list,
      bitstring_status_list: { revocation: `${list}/bitstring`, suspension: `${list}/bitstring/suspension` },
    }]);
    expect(claims.endpoints).toEqual({
      agent_by_did: 'https://grantex.dev/v1/registry/agents/{agent_did}',
      agent_by_key_thumbprint: 'https://grantex.dev/v1/registry/agents?key_thumbprint={key_thumbprint}',
      agent_by_credential:
        'https://grantex.dev/v1/registry/agents?issuer={issuer}&external_credential_id={external_credential_id}&hash={hash}',
      issuers: 'https://grantex.dev/v1/registry/issuers',
      acceptance_status_list: 'https://grantex.dev/status/attestations/{list}',
      jwks_uri: 'https://grantex.dev/.well-known/jwks.json',
    });
  });

  it('is byte-stable within an issue interval, and moves iat to a later change', async () => {
    const a = await signRegistryManifest(CONTENT, NOW);
    const b = await signRegistryManifest(CONTENT, new Date(NOW.getTime() + 60_000));
    expect(b.token).toBe(a.token);
    expect(b.etag).toBe(a.etag);
    const changed = await signRegistryManifest({ ...CONTENT, lastChange: new Date('2026-09-28T12:06:10Z') }, NOW);
    expect(changed.claims.iat).toBe(Math.floor(Date.parse('2026-09-28T12:06:10Z') / 1000));
    expect(changed.etag).not.toBe(a.etag);
  });

  it('never states a change it has not seen: a later change in the future does not move iat past now', async () => {
    const future = await signRegistryManifest({ ...CONTENT, lastChange: new Date(NOW.getTime() + 600_000) }, NOW);
    expect(future.claims.iat).toBeLessThanOrEqual(Math.floor(NOW.getTime() / 1000));
  });
});

describe('verifyRegistryManifest', () => {
  it('accepts the published manifest with the published JWK Set', async () => {
    const signed = await signRegistryManifest(CONTENT, NOW);
    const claims = await verifyRegistryManifest(signed.token, jwks, NOW, REGISTRY);
    expect(claims).toEqual(signed.claims);
  });

  it('refuses to verify without the issuer the relying party trusts', async () => {
    const signed = await signRegistryManifest(CONTENT, NOW);
    for (const options of [undefined, {}, { issuer: '' }, { issuer: 42 }]) {
      const err = await refusal(verifyRegistryManifest(signed.token, jwks, NOW, options as never));
      expect(err.code, JSON.stringify(options)).toBe('passport_invalid_signature');
    }
  });

  it('refuses another typ, including the prefixed spelling and plain JWT', async () => {
    const { claims } = await signRegistryManifest(CONTENT, NOW);
    for (const typ of ['JWT', 'statuslist+jwt', `application/${REGISTRY_MANIFEST_TYP}`]) {
      const err = await refusal(verifyRegistryManifest(await platformSigned({ ...claims }, { typ }), jwks, NOW, REGISTRY));
      expect(err.code).toBe('passport_invalid_signature');
    }
  });

  it('refuses a signature by a key the set does not hold, and a key named in the header', async () => {
    const { claims } = await signRegistryManifest(CONTENT, NOW);
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const foreign = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: getKeyPair().kid, typ: REGISTRY_MANIFEST_TYP }).sign(privateKey);
    expect((await refusal(verifyRegistryManifest(foreign, jwks, NOW, REGISTRY))).code).toBe('passport_invalid_signature');
    const embedded = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256', typ: REGISTRY_MANIFEST_TYP, jwk: await exportJWK(publicKey) } as never).sign(privateKey);
    expect((await refusal(verifyRegistryManifest(embedded, jwks, NOW, REGISTRY))).code).toBe('passport_invalid_signature');
  });

  it('refuses alg none and a tampered payload', async () => {
    const signed = await signRegistryManifest(CONTENT, NOW);
    const [, payload] = signed.token.split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: REGISTRY_MANIFEST_TYP })).toString('base64url')}.${payload}.`;
    expect((await refusal(verifyRegistryManifest(none, jwks, NOW, REGISTRY))).code).toBe('passport_invalid_signature');
    const [header, , signature] = signed.token.split('.');
    const tampered = `${header}.${Buffer.from(JSON.stringify({ ...signed.claims, issuers: [] })).toString('base64url')}.${signature}`;
    expect((await refusal(verifyRegistryManifest(tampered, jwks, NOW, REGISTRY))).code).toBe('passport_invalid_signature');
    expect((await refusal(verifyRegistryManifest('not-a-jws', jwks, NOW, REGISTRY))).code).toBe('passport_invalid_signature');
  });

  it('refuses a manifest at or after exp with status_stale', async () => {
    const signed = await signRegistryManifest(CONTENT, NOW);
    const atExp = new Date(signed.claims.exp * 1000);
    expect((await refusal(verifyRegistryManifest(signed.token, jwks, atExp, REGISTRY))).code).toBe('status_stale');
    await expect(verifyRegistryManifest(signed.token, jwks, new Date(atExp.getTime() - 1000), REGISTRY)).resolves.toBeDefined();
  });

  it('refuses a manifest more than an hour old whatever its exp says', async () => {
    const { claims } = await signRegistryManifest(CONTENT, NOW);
    const long = await platformSigned({ ...claims, exp: claims.iat + 6 * REGISTRY_MANIFEST_LIFETIME_SECONDS });
    const later = new Date((claims.iat + REGISTRY_MANIFEST_MAX_AGE_SECONDS + 1) * 1000);
    expect((await refusal(verifyRegistryManifest(long, jwks, later, REGISTRY))).code).toBe('status_stale');
    // Even while it is younger than an hour, a lifetime over the bound is refused.
    expect((await refusal(verifyRegistryManifest(long, jwks, NOW, REGISTRY))).code).toBe('status_stale');
  });

  it('refuses a manifest issued in the future beyond the clock tolerance', async () => {
    const { claims } = await signRegistryManifest(CONTENT, NOW);
    const ahead = await platformSigned({ ...claims, iat: claims.iat + 600, exp: claims.exp + 600 });
    expect((await refusal(verifyRegistryManifest(ahead, jwks, new Date(claims.iat * 1000), REGISTRY))).code).toBe('status_stale');
  });

  it('refuses another issuer, and a payload missing a member', async () => {
    const { claims } = await signRegistryManifest(CONTENT, NOW);
    const signed = await platformSigned({ ...claims });
    expect((await refusal(verifyRegistryManifest(signed, jwks, NOW, { issuer: 'https://registry.example' }))).code)
      .toBe('passport_invalid_signature');
    const { issuers: _dropped, ...rest } = claims;
    expect((await refusal(verifyRegistryManifest(await platformSigned(rest), jwks, NOW, REGISTRY))).code)
      .toBe('passport_invalid_signature');
  });
});

describe('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('off (the default): no manifest route, and the lookup needs an API key', async () => {
    app = await buildTestApp();
    expect((await app.inject({ method: 'GET', url: REGISTRY_MANIFEST_PATH })).statusCode).toBe(404);
    const lookup = await app.inject({ method: 'GET', url: '/v1/registry/agents/did%3Agrantex%3Aag_TEST01AGENTID' });
    expect(lookup.statusCode).toBe(401);
  });

  it('only the exact value true turns it on', async () => {
    vi.stubEnv('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', 'TRUE');
    app = await buildTestApp();
    expect((await app.inject({ method: 'GET', url: REGISTRY_MANIFEST_PATH })).statusCode).toBe(404);
  });

  it('on: the unauthenticated lookup is limited per client address', async () => {
    vi.stubEnv('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', 'true');
    app = await buildTestApp();
    sqlMock.mockResolvedValue([]);
    const url = `/v1/registry/agents?key_thumbprint=${'A'.repeat(43)}`;
    for (let i = 0; i < LOOKUP_RATE_LIMIT_PER_MINUTE; i += 1) {
      const res = await app.inject({ method: 'GET', url, remoteAddress: '192.0.2.77' });
      expect(res.statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url, remoteAddress: '192.0.2.77' })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url, remoteAddress: '192.0.2.78' })).statusCode).toBe(404);
  });

  it('on: the manifest is served, and a store that cannot be read is a 5xx, never an empty manifest', async () => {
    vi.stubEnv('REGISTRY_PUBLIC_ENDPOINTS_ENABLED', 'true');
    app = await buildTestApp();
    sqlMock.mockResolvedValue([]);
    const ok = await app.inject({ method: 'GET', url: REGISTRY_MANIFEST_PATH });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['access-control-allow-origin']).toBe('*');
    sqlMock.mockRejectedValue(new Error('connection terminated'));
    const down = await app.inject({ method: 'GET', url: REGISTRY_MANIFEST_PATH });
    expect(down.statusCode).toBeGreaterThanOrEqual(500);
    sqlMock.mockResolvedValue([]);
  });
});
