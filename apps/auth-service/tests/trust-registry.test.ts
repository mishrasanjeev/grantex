import { describe, it, expect, beforeAll, vi } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER } from './helpers.js';
import type { FastifyInstance } from 'fastify';

// Mock node:dns/promises to control verifyDnsTxt behavior
const mockResolve = vi.fn();
vi.mock('node:dns/promises', () => ({
  resolve: (...args: unknown[]) => mockResolve(...args),
}));

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// -----------------------------------------------------------------
// GET /v1/registry/orgs — Public: search organizations
// -----------------------------------------------------------------
describe('GET /v1/registry/orgs', () => {
  it('returns results without auth (public)', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        organization_did: 'did:web:example.com',
        domain: 'example.com',
        name: 'Example Corp',
        description: 'An example org',
        trust_level: 'verified',
        badges: ['dns-verified'],
        total_agents: 3,
        weekly_active_grants: 42,
        average_rating: 4.5,
        review_count: 10,
        website: 'https://example.com',
        logo_url: 'https://example.com/logo.png',
        created_at: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs',
      // No auth headers — public endpoint
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].did).toBe('did:web:example.com');
    expect(body.data[0].name).toBe('Example Corp');
    expect(body.data[0].verificationLevel).toBe('verified');
    expect(body.data[0].stats.totalAgents).toBe(3);
    expect(body.data[0].stats.weeklyActiveGrants).toBe(42);
    expect(body.meta).toBeDefined();
  });

  it('filters by verified=true', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        organization_did: 'did:web:verified.com',
        domain: 'verified.com',
        name: 'Verified Corp',
        trust_level: 'verified',
        badges: [],
        total_agents: 0,
        weekly_active_grants: 0,
        average_rating: 0,
        review_count: 0,
        website: null,
        logo_url: null,
        created_at: new Date(),
      },
      {
        id: 'treg_2',
        organization_did: 'did:web:basic.com',
        domain: 'basic.com',
        name: 'Basic Corp',
        trust_level: 'basic',
        badges: [],
        total_agents: 0,
        weekly_active_grants: 0,
        average_rating: 0,
        review_count: 0,
        website: null,
        logo_url: null,
        created_at: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?verified=true',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].did).toBe('did:web:verified.com');
  });

  it('searches by name (q param)', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        organization_did: 'did:web:acme.com',
        domain: 'acme.com',
        name: 'Acme Industries',
        description: 'Building things',
        trust_level: 'basic',
        badges: [],
        total_agents: 0,
        weekly_active_grants: 0,
        average_rating: 0,
        review_count: 0,
        website: null,
        logo_url: null,
        created_at: new Date(),
      },
      {
        id: 'treg_2',
        organization_did: 'did:web:other.com',
        domain: 'other.com',
        name: 'Other Corp',
        description: null,
        trust_level: 'basic',
        badges: [],
        total_agents: 0,
        weekly_active_grants: 0,
        average_rating: 0,
        review_count: 0,
        website: null,
        logo_url: null,
        created_at: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?q=acme',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Acme Industries');
  });
});

// -----------------------------------------------------------------
// GET /v1/registry/orgs/:did — Public: org detail
// -----------------------------------------------------------------
describe('GET /v1/registry/orgs/:did', () => {
  it('returns org detail with agents', async () => {
    // First query: trust_registry lookup
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        organization_did: 'did:web:example.com',
        domain: 'example.com',
        name: 'Example Corp',
        description: 'A test org',
        trust_level: 'verified',
        badges: ['dns-verified'],
        total_agents: 1,
        weekly_active_grants: 10,
        average_rating: 4.2,
        review_count: 5,
        website: 'https://example.com',
        logo_url: null,
        public_keys: [{ kty: 'RSA', kid: 'key-1' }],
        compliance_soc2: true,
        compliance_iso27001: false,
        compliance_dpdp: false,
        compliance_gdpr: true,
        contact_security: 'security@example.com',
        contact_dpo: null,
        verified_at: new Date('2026-03-01'),
        verification_method: 'dns-txt',
        created_at: new Date(),
      },
    ]);

    // Second query: registry_agents
    sqlMock.mockResolvedValueOnce([
      {
        id: 'ragent_1',
        agent_did: 'did:grantex:ag_1',
        name: 'Agent Alpha',
        description: 'A helper',
        version: '1.0.0',
        scopes: ['read'],
        category: 'assistant',
        npm_package: '@example/agent-alpha',
        pypi_package: null,
        github_url: 'https://github.com/example/agent-alpha',
        weekly_active_grants: 5,
        rating: 4.0,
        review_count: 3,
        listed: true,
        created_at: new Date(),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs/did:web:example.com',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.did).toBe('did:web:example.com');
    expect(body.name).toBe('Example Corp');
    expect(body.compliance.soc2).toBe(true);
    expect(body.compliance.gdpr).toBe(true);
    expect(body.compliance.iso27001).toBe(false);
    expect(body.contact.security).toBe('security@example.com');
    expect(body.publicKeys).toHaveLength(1);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe('Agent Alpha');
    expect(body.agents[0].npmPackage).toBe('@example/agent-alpha');
  });

  it('returns 404 for unknown DID', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs/did:web:nonexistent.com',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// -----------------------------------------------------------------
// GET /v1/registry/orgs/:did/jwks — Public: org JWK set
// -----------------------------------------------------------------
describe('GET /v1/registry/orgs/:did/jwks', () => {
  it('returns JWK set', async () => {
    sqlMock.mockResolvedValueOnce([
      {
        public_keys: [
          { kty: 'RSA', kid: 'key-1', n: 'abc', e: 'AQAB' },
          { kty: 'EC', kid: 'key-2', crv: 'P-256' },
        ],
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs/did:web:example.com/jwks',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keys).toHaveLength(2);
    expect(body.keys[0].kty).toBe('RSA');
    expect(body.keys[1].kty).toBe('EC');
  });

  it('returns 404 for unknown org', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs/did:web:unknown.com/jwks',
    });

    expect(res.statusCode).toBe(404);
  });
});

// -----------------------------------------------------------------
// POST /v1/registry/orgs — Protected: register org
// -----------------------------------------------------------------
describe('POST /v1/registry/orgs', () => {
  it('creates org (201)', async () => {
    seedAuth();
    // Insert into trust_registry
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        did: 'did:web:neworg.com',
        name: 'New Org',
        description: 'A brand new org',
        website: 'https://neworg.com',
        contact: { security: 'sec@neworg.com' },
        requestVerification: true,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.orgId).toBeDefined();
    expect(body.orgId).toMatch(/^treg_/);
    expect(body.did).toBe('did:web:neworg.com');
    expect(body.name).toBe('New Org');
    expect(body.trustLevel).toBe('basic');
    expect(body.verificationToken).toBeDefined();
    expect(body.instructions).toContain('_grantex-verify.neworg.com');
  });

  it('rejects missing name (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        did: 'did:web:neworg.com',
        // name is missing
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects missing did (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        name: 'No DID Org',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

// -----------------------------------------------------------------
// POST /v1/registry/orgs/:orgId/verify-dns — Protected: DNS verify
// -----------------------------------------------------------------
describe('POST /v1/registry/orgs/:orgId/verify-dns', () => {
  it('verifies DNS successfully', async () => {
    seedAuth();
    // Lookup org
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        domain: 'example.com',
        organization_did: 'did:web:example.com',
        developer_id: TEST_DEVELOPER.id,
      },
    ]);

    // Mock DNS resolution to succeed
    mockResolve.mockResolvedValueOnce([['grantex-verify=did:web:example.com']]);

    // Update trust_registry (badges not yet present)
    sqlMock.mockResolvedValueOnce([]);
    // Update trust_registry (badges already present path)
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs/treg_1/verify-dns',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verified).toBe(true);
    expect(body.verificationMethod).toBe('dns-txt');
    expect(body.trustLevel).toBe('verified');
    expect(body.domain).toBe('example.com');
  });

  it('fails on DNS miss', async () => {
    seedAuth();
    // Lookup org
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_2',
        domain: 'nodns.com',
        organization_did: 'did:web:nodns.com',
        developer_id: TEST_DEVELOPER.id,
      },
    ]);

    // Mock DNS resolution to fail (no records)
    mockResolve.mockRejectedValueOnce(new Error('ENOTFOUND'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs/treg_2/verify-dns',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('DNS_VERIFICATION_FAILED');
  });

  it('returns 404 for unknown orgId', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs/treg_nonexistent/verify-dns',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// -----------------------------------------------------------------
// Legacy endpoints (backward compat)
// -----------------------------------------------------------------
describe('GET /v1/trust-registry/:orgDID (legacy)', () => {
  it('returns org record (public)', async () => {
    // trust_registry lookup
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        organization_did: 'did:web:legacy.com',
        domain: 'legacy.com',
        verified_at: new Date('2026-01-15'),
        verification_method: 'dns-txt',
        trust_level: 'verified',
        name: 'Legacy Corp',
        description: null,
        badges: [],
        total_agents: 0,
        weekly_active_grants: 0,
        average_rating: 0,
      },
    ]);
    // registry_agents lookup
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/trust-registry/did:web:legacy.com',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.organizationDID).toBe('did:web:legacy.com');
    expect(body.trustLevel).toBe('verified');
    expect(body.domains).toEqual(['legacy.com']);
    expect(body.agents).toEqual([]);
  });
});
