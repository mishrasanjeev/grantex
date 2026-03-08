import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp } from './helpers.js';
import { initEdKey } from '../src/lib/crypto.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  await initEdKey();
  app = await buildTestApp();
});

describe('GET /.well-known/did.json', () => {
  it('returns 200 with a valid DID document (no auth required)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body['@context']).toBeDefined();
    expect(body['@context']).toContain('https://www.w3.org/ns/did/v1');
    expect(body['@context']).toContain('https://w3id.org/security/suites/jws-2020/v1');
  });

  it('contains did:web:grantex.dev as the id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
    });

    const body = res.json();
    expect(body.id).toBe('did:web:grantex.dev');
  });

  it('includes the RS256 verification method', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
    });

    const body = res.json();
    const methods = body.verificationMethod as Array<Record<string, unknown>>;
    expect(methods.length).toBeGreaterThanOrEqual(1);

    const rsaMethod = methods.find((m) => {
      const jwk = m['publicKeyJwk'] as Record<string, unknown>;
      return jwk['alg'] === 'RS256';
    });
    expect(rsaMethod).toBeDefined();
    expect(rsaMethod!['type']).toBe('JsonWebKey2020');
    expect(rsaMethod!['controller']).toBe('did:web:grantex.dev');
    expect((rsaMethod!['id'] as string).startsWith('did:web:grantex.dev#')).toBe(true);
  });

  it('has populated authentication and assertionMethod arrays', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
    });

    const body = res.json();
    expect(body.authentication).toBeDefined();
    expect(Array.isArray(body.authentication)).toBe(true);
    expect(body.authentication.length).toBeGreaterThanOrEqual(1);

    expect(body.assertionMethod).toBeDefined();
    expect(Array.isArray(body.assertionMethod)).toBe(true);
    expect(body.assertionMethod.length).toBeGreaterThanOrEqual(1);

    // authentication and assertionMethod should reference verificationMethod ids
    const methodIds = (body.verificationMethod as Array<Record<string, unknown>>).map(
      (m) => m['id'],
    );
    for (const authId of body.authentication) {
      expect(methodIds).toContain(authId);
    }
    for (const assertId of body.assertionMethod) {
      expect(methodIds).toContain(assertId);
    }
  });

  it('lists service endpoints', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
    });

    const body = res.json();
    expect(body.service).toBeDefined();
    expect(Array.isArray(body.service)).toBe(true);
    expect(body.service.length).toBe(2);

    const jwksService = body.service.find(
      (s: Record<string, unknown>) => s['type'] === 'JsonWebKeySet',
    );
    expect(jwksService).toBeDefined();
    expect(jwksService['serviceEndpoint']).toBe('https://grantex.dev/.well-known/jwks.json');
    expect(jwksService['id']).toBe('did:web:grantex.dev#jwks');

    const protocolService = body.service.find(
      (s: Record<string, unknown>) => s['type'] === 'GrantexProtocol',
    );
    expect(protocolService).toBeDefined();
    expect(protocolService['serviceEndpoint']).toBe('https://api.grantex.dev/v1');
    expect(protocolService['id']).toBe('did:web:grantex.dev#grant-protocol');
  });

  it('does not require Authorization header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/did.json',
      // No authorization header
    });
    expect(res.statusCode).toBe(200);
  });
});
