// SPDX-License-Identifier: Apache-2.0
/**
 * The registry's HTTP Message Signatures key directory (G50) with the
 * database mocked: which agent keys are listed, the document and its
 * media type, the Content-Digest, the registry's RFC 9421 response
 * signature verified with the platform public key, the flag that decides
 * whether the route exists, and the developer opt-in route.
 */
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getKeyPair } from '../src/lib/crypto.js';
import { jwkThumbprint } from '../src/lib/registry/jwk-thumbprint.js';
import {
  REGISTRY_DIRECTORY_TAG,
  SIGNATURE_DIRECTORY_MEDIA_TYPE,
  SIGNATURE_DIRECTORY_PATH,
  buildDirectoryDocument,
  contentDigest,
  directoryKeyFromRow,
  signDirectoryResponse,
} from '../src/lib/registry/signature-directory.js';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

const AT = new Date('2026-10-20T12:00:00Z');
const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, string>;
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as Record<string, string>;
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }) as Record<string, string>;

function row(jwk: Record<string, string>, alg: string, overrides: Record<string, unknown> = {}) {
  return {
    thumbprint: jwkThumbprint(jwk),
    jwk,
    alg,
    status: 'active',
    valid_from: '2026-10-01T00:00:00Z',
    valid_to: null,
    possession_proved_at: '2026-10-01T00:05:00Z',
    db_now: AT.toISOString(),
    ...overrides,
  };
}

let app: FastifyInstance | undefined;
beforeAll(async () => {
  // Initialises the platform signing keys.
  const first = await buildTestApp();
  await first.close();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await app?.close();
  app = undefined;
  sqlMock.mockReset();
  sqlMock.mockResolvedValue([]);
});

describe('directory entries', () => {
  it('lists usable Ed25519 and P-256 keys with kid = RFC 7638 thumbprint, use, nbf and exp', () => {
    expect(directoryKeyFromRow(row(ed, 'EdDSA'), AT)).toEqual({
      kty: 'OKP', crv: 'Ed25519', x: ed['x'], kid: jwkThumbprint(ed), use: 'sig', nbf: Date.parse('2026-10-01T00:00:00Z') / 1000,
    });
    const rotated = directoryKeyFromRow(row(ec, 'ES256', { status: 'rotated', valid_to: '2026-10-21T00:00:00Z' }), AT);
    expect(rotated).toMatchObject({ kty: 'EC', crv: 'P-256', x: ec['x'], y: ec['y'], kid: jwkThumbprint(ec), exp: Date.parse('2026-10-21T00:00:00Z') / 1000 });
  });

  it('never lists a pending, unproven, compromised, ended or unsupported key', () => {
    expect(directoryKeyFromRow(row(ed, 'EdDSA', { status: 'pending', possession_proved_at: null }), AT)).toBeNull();
    expect(directoryKeyFromRow(row(ed, 'EdDSA', { possession_proved_at: null }), AT)).toBeNull();
    expect(directoryKeyFromRow(row(ed, 'EdDSA', { status: 'compromised', valid_to: '2026-10-02T00:00:00Z' }), AT)).toBeNull();
    expect(directoryKeyFromRow(row(ec, 'ES256', { status: 'rotated', valid_to: '2026-10-19T00:00:00Z' }), AT)).toBeNull();
    expect(directoryKeyFromRow(row(rsa, 'RS256'), AT)).toBeNull();
    // A row whose stored thumbprint is not its key's is not published.
    expect(directoryKeyFromRow(row(ed, 'EdDSA', { thumbprint: jwkThumbprint(ec) }), AT)).toBeNull();
    // The algorithm column and the key type must agree.
    expect(directoryKeyFromRow(row(ed, 'ES256'), AT)).toBeNull();
  });

  it('builds a JWK Set in kid order, without duplicates', () => {
    const doc = buildDirectoryDocument([row(ec, 'ES256'), row(ed, 'EdDSA'), row(ed, 'EdDSA'), row(rsa, 'RS256')], AT);
    expect(doc.keys.map((k) => k.kid)).toEqual([jwkThumbprint(ec), jwkThumbprint(ed)].sort());
  });
});

async function verifyRegistrySignature(headers: Record<string, string>, body: string, authority: string) {
  const input = headers['Signature-Input']!;
  const m = /^registry=(.*)$/.exec(input);
  if (!m) throw new Error('no registry signature');
  const base = [`"@authority";req: ${authority}`, `"content-digest": ${headers['Content-Digest']}`, `"@signature-params": ${m[1]}`].join('\n');
  const sig = Buffer.from(/^registry=:(.*):$/.exec(headers['Signature']!)![1]!, 'base64');
  const { publicKey, alg } = getKeyPair();
  const algorithm = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  return webcrypto.subtle.verify(algorithm, publicKey as webcrypto.CryptoKey, sig, Buffer.from(base, 'ascii'));
}

describe('the registry response signature', () => {
  it('covers "@authority";req and content-digest with the platform key and kid', async () => {
    const body = JSON.stringify({ keys: [] });
    const now = new Date('2026-10-20T12:00:00Z');
    const headers = await signDirectoryResponse(body, { now, authority: 'registry.example' });
    const { kid } = getKeyPair();
    expect(headers['Content-Type']).toBe(SIGNATURE_DIRECTORY_MEDIA_TYPE);
    expect(headers['Content-Digest']).toBe(`sha-256=:${createHash('sha256').update(body).digest('base64')}:`);
    expect(headers['Signature-Input']).toMatch(
      new RegExp(`^registry=\\("@authority";req "content-digest"\\);created=${now.getTime() / 1000};expires=${now.getTime() / 1000 + 300};keyid="${kid}";alg="(ecdsa-p256-sha256|rsa-v1_5-sha256)";tag="${REGISTRY_DIRECTORY_TAG}"$`),
    );
    expect(await verifyRegistrySignature(headers, body, 'registry.example')).toBe(true);
    // Another authority, or another body, does not verify.
    expect(await verifyRegistrySignature(headers, body, 'elsewhere.example')).toBe(false);
    expect(await verifyRegistrySignature({ ...headers, 'Content-Digest': contentDigest('{"keys":[1]}') }, body, 'registry.example')).toBe(false);
  });
});

describe('GET /.well-known/http-message-signatures-directory', () => {
  it('does not exist when HTTP_SIGNATURE_DIRECTORY_ENABLED is unset', async () => {
    app = await buildTestApp();
    expect((await app.inject({ method: 'GET', url: SIGNATURE_DIRECTORY_PATH })).statusCode).toBe(404);
  });

  it('does not exist unless HTTP_SIGNATURE_DIRECTORY_ENABLED is exactly true', async () => {
    vi.stubEnv('HTTP_SIGNATURE_DIRECTORY_ENABLED', 'TRUE');
    app = await buildTestApp();
    expect((await app.inject({ method: 'GET', url: SIGNATURE_DIRECTORY_PATH })).statusCode).toBe(404);
  });

  it('on: serves the opted-in agents\' usable keys, unauthenticated, with digest and signature', async () => {
    vi.stubEnv('HTTP_SIGNATURE_DIRECTORY_ENABLED', 'true');
    app = await buildTestApp();
    sqlMock.mockImplementation(async (strings: unknown) =>
      Array.isArray(strings) && (strings as string[]).join('').includes('agent_keys')
        ? [row(ed, 'EdDSA'), row(ec, 'ES256', { status: 'pending', possession_proved_at: null })]
        : []);
    const res = await app.inject({ method: 'GET', url: SIGNATURE_DIRECTORY_PATH });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe(SIGNATURE_DIRECTORY_MEDIA_TYPE);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.json()).toEqual({ keys: [expect.objectContaining({ kid: jwkThumbprint(ed), use: 'sig' })] });
    expect(res.headers['content-digest']).toBe(contentDigest(res.body));
    expect(await verifyRegistrySignature(
      { 'Signature-Input': res.headers['signature-input'] as string, Signature: res.headers['signature'] as string, 'Content-Digest': res.headers['content-digest'] as string },
      res.body,
      (await import('../src/lib/registry/signature-directory.js')).registryAuthority(),
    )).toBe(true);
    // The query filters on the opt-in and the agent being active.
    const query = sqlMock.mock.calls
      .map((call) => (Array.isArray(call[0]) ? (call[0] as readonly string[]).join('?') : ''))
      .find((text) => text.includes('agent_keys')) ?? '';
    expect(query).toContain('a.http_signature_directory');
    expect(query).toContain("a.status = 'active'");
  });

  it('on: a database that cannot be read answers 500, never an empty directory', async () => {
    vi.stubEnv('HTTP_SIGNATURE_DIRECTORY_ENABLED', 'true');
    app = await buildTestApp();
    sqlMock.mockImplementation(async (strings: unknown) => {
      if (Array.isArray(strings) && (strings as string[]).join('').includes('agent_keys')) throw new Error('connection terminated');
      return [];
    });
    expect((await app.inject({ method: 'GET', url: SIGNATURE_DIRECTORY_PATH })).statusCode).toBe(500);
  });
});

describe('PUT /v1/agents/:id/http-signature-directory', () => {
  const url = `/v1/agents/${TEST_AGENT.id}/http-signature-directory`;

  it('requires a developer API key, a boolean, and the developer\'s own agent', async () => {
    app = await buildTestApp();
    expect((await app.inject({ method: 'PUT', url, payload: { published: true } })).statusCode).toBe(401);
    seedAuth();
    const bad = await app.inject({ method: 'PUT', url, headers: authHeader(), payload: { published: 'yes' } });
    expect(bad.statusCode).toBe(400);
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // the agent lookup, scoped by developer
    const missing = await app.inject({ method: 'PUT', url, headers: authHeader(), payload: { published: true } });
    expect(missing.statusCode, missing.body).toBe(404);
  });
});
