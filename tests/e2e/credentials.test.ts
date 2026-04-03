/**
 * E2E Tests: Verifiable Credentials
 *
 * Tests VC listing, VC verification, DID document, JWKS, and status list endpoints.
 * Run: npx vitest run tests/e2e/credentials.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Grantex } from '@grantex/sdk';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://grantex-auth-dd4mtrt2gq-uc.a.run.app';

let grantex: Grantex;
let apiKey: string;

beforeAll(async () => {
  const account = await Grantex.signup({ name: `e2e-creds-${Date.now()}`, mode: 'sandbox' }, { baseUrl: BASE_URL });
  apiKey = account.apiKey;
  grantex = new Grantex({ apiKey, baseUrl: BASE_URL });
});

describe('E2E: Credential Listing', () => {
  it('lists credentials (initially empty)', async () => {
    const result = await grantex.credentials.list();
    expect(result).toBeDefined();
    expect(result.credentials).toBeDefined();
    expect(Array.isArray(result.credentials)).toBe(true);
    expect(result.credentials.length).toBe(0);
  });

  it('lists credentials with grantId filter', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials?grantId=grnt_nonexistent`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { credentials: any[] };
    expect(body.credentials).toBeDefined();
    expect(body.credentials.length).toBe(0);
  });

  it('lists credentials with status filter', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials?status=active`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { credentials: any[] };
    expect(body.credentials).toBeDefined();
    expect(Array.isArray(body.credentials)).toBe(true);
  });

  it('returns 404 for non-existent credential by ID', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials/vc_nonexistent_000`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND');
  });
});

describe('E2E: VC Verification', () => {
  it('rejects verification with missing credential', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('rejects verification with invalid JWT', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: 'not-a-valid-jwt' }),
    });
    // Should return 200 with valid=false or a 400 error
    const body = (await res.json()) as { valid?: boolean; code?: string };
    if (res.ok) {
      expect(body.valid).toBe(false);
    } else {
      expect(body.code).toBeDefined();
    }
  });
});

describe('E2E: SD-JWT Presentation', () => {
  it('rejects presentation with missing sdJwt', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials/present`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('rejects presentation with invalid SD-JWT', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials/present`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdJwt: 'invalid~sd~jwt' }),
    });
    const body = (await res.json()) as { valid?: boolean; code?: string };
    if (res.ok) {
      expect(body.valid).toBe(false);
    } else {
      expect(body.code).toBeDefined();
    }
  });
});

describe('E2E: DID & JWKS Public Endpoints', () => {
  it('DID document is accessible and has required fields', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/did.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toHaveProperty('id');
    expect(doc).toHaveProperty('verificationMethod');
    expect(doc['@context']).toBeDefined();
    expect(typeof doc.id).toBe('string');
    expect(Array.isArray(doc.verificationMethod)).toBe(true);
  });

  it('JWKS endpoint returns valid key set', async () => {
    const res = await fetch(`${BASE_URL}/.well-known/jwks.json`);
    expect(res.status).toBe(200);
    const jwks = (await res.json()) as { keys: any[] };
    expect(jwks).toHaveProperty('keys');
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);

    // Each key should have required JWK fields
    const key = jwks.keys[0];
    expect(key).toHaveProperty('kty');
    expect(key).toHaveProperty('kid');
  });

  it('StatusList endpoint returns 404 for non-existent list', async () => {
    const res = await fetch(`${BASE_URL}/v1/credentials/status/nonexistent-list`);
    expect(res.status).toBe(404);
  });
});
