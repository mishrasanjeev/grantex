import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildTestApp, seedAuth, authHeader, sqlMock, TEST_DEVELOPER, TEST_ADMIN_API_KEY } from './helpers.js';
import { config } from '../src/config.js';
import { trustRegistryAdminListingEnforced, verifyDnsTxt } from '../src/routes/trust-registry.js';
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

function registryRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organization_did: `did:web:${id}.example`,
    domain: `${id}.example`,
    name: `Organization ${id}`,
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
    ...overrides,
  };
}

function sqlText(callIndex: number): string {
  return (sqlMock.mock.calls[callIndex]?.[0] as readonly string[]).join(' ');
}

// -----------------------------------------------------------------
// GET /v1/registry/orgs — Public: search organizations
// -----------------------------------------------------------------
describe('GET /v1/registry/orgs', () => {
  it('returns results without auth (public)', async () => {
    sqlMock.mockResolvedValueOnce([{ total: 1 }]);
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
    expect(body.meta).toEqual({ total: 1 });
  });

  it('filters by verified=true', async () => {
    sqlMock.mockResolvedValueOnce([{ total: 1 }]);
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
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?verified=true',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].did).toBe('did:web:verified.com');
    expect(sqlText(0)).toContain("t.trust_level = 'verified'");
    expect(sqlText(1)).toContain("t.trust_level = 'verified'");
  });

  it('searches by name (q param)', async () => {
    sqlMock.mockResolvedValueOnce([{ total: 1 }]);
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
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?q=acme',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].name).toBe('Acme Industries');
    expect(sqlMock.mock.calls[0]?.slice(1)).toContain('%acme%');
    expect(sqlMock.mock.calls[1]?.slice(1)).toContain('%acme%');
  });

  it('applies category filtering in SQL and reports the full filtered total', async () => {
    sqlMock.mockResolvedValueOnce([{ total: 27 }]);
    sqlMock.mockResolvedValueOnce([
      registryRow('treg_payments', {
        organization_did: 'did:web:payments.example',
        name: 'Payments Org',
      }),
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?category=payments&limit=1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().meta).toEqual({ total: 27 });
    expect(sqlText(0)).toContain('EXISTS');
    expect(sqlText(1)).toContain('EXISTS');
    expect(sqlMock.mock.calls[0]?.slice(1)).toContain('payments');
    expect(sqlMock.mock.calls[1]?.slice(1)).toContain('payments');
  });

  it('uses a stable database cursor across multiple pages', async () => {
    sqlMock
      .mockResolvedValueOnce([{ total: 3 }])
      .mockResolvedValueOnce([
        registryRow('treg_3'),
        registryRow('treg_2'),
        registryRow('treg_1'),
      ])
      .mockResolvedValueOnce([{ total: 3 }])
      .mockResolvedValueOnce([registryRow('treg_1')]);

    const first = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?limit=2',
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.map((org: { did: string }) => org.did)).toEqual([
      'did:web:treg_3.example',
      'did:web:treg_2.example',
    ]);
    expect(first.json().meta).toEqual({ total: 3, cursor: 'treg_2' });

    const second = await app.inject({
      method: 'GET',
      url: '/v1/registry/orgs?limit=2&cursor=treg_2',
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.map((org: { did: string }) => org.did)).toEqual([
      'did:web:treg_1.example',
    ]);
    expect(second.json().meta).toEqual({ total: 3 });
    expect(sqlText(3)).toContain('WHERE c.id =');
    expect(sqlMock.mock.calls[3]?.slice(1)).toContain('treg_2');
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
    expect(body.domain).toBe('neworg.com');
    expect(body.dnsRecordName).toBe('_grantex-verify.neworg.com');
    expect(body.verificationToken).toBeDefined();
    expect(body.instructions).toContain('_grantex-verify.neworg.com');
  });

  it('returns a DNS record name derived from the host of a path-based did:web', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        did: 'did:web:example.com:teams:registry',
        name: 'Path DID Org',
        requestVerification: true,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().domain).toBe('example.com');
    expect(res.json().dnsRecordName).toBe('_grantex-verify.example.com');
    expect(res.json().instructions).not.toContain('example.com:teams:registry');
  });

  it('returns an owner-safe conflict when the DID is already registered', async () => {
    seedAuth();
    sqlMock.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        did: 'did:web:existing.example',
        name: 'Existing Org',
        requestVerification: true,
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      message: 'This organization DID is already registered',
      code: 'CONFLICT',
    });
    expect(res.json().verificationToken).toBeUndefined();
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

  it('rejects verification methods that are not implemented', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        did: 'did:web:neworg.com',
        name: 'New Org',
        verificationMethod: 'soc2',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('UNSUPPORTED_VERIFICATION_METHOD');
  });

  it('rejects identifiers that cannot be verified through did:web DNS ownership', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/registry/orgs',
      headers: authHeader(),
      payload: {
        did: 'did:key:z6Mktest',
        name: 'Unsupported DID Org',
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
    const verificationToken = 'grantex-verify=token-from-registration';
    const verificationTokenHash = createHash('sha256').update(verificationToken).digest('hex');
    // Lookup org
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_1',
        domain: 'example.com',
        organization_did: 'did:web:example.com',
        developer_id: TEST_DEVELOPER.id,
        verification_token_hash: verificationTokenHash,
      },
    ]);

    // Mock DNS resolution to succeed
    mockResolve.mockResolvedValueOnce([[verificationToken]]);

    // Update trust_registry and add the badge if needed
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

  it('requires the exact registered token instead of accepting an arbitrary prefix', async () => {
    const expectedToken = 'grantex-verify=expected-token';
    const expectedHash = createHash('sha256').update(expectedToken).digest('hex');
    mockResolve.mockResolvedValueOnce([['grantex-verify=attacker-controlled']]);

    await expect(verifyDnsTxt('example.com', expectedHash)).resolves.toBe(false);
  });

  it('retains the exact legacy did:web proof for registrations without a token hash', async () => {
    mockResolve.mockResolvedValueOnce([['grantex-verify=did:web:legacy.example']]);

    await expect(verifyDnsTxt('legacy.example', null)).resolves.toBe(true);
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

describe('POST /v1/trust-registry/verify-dns (legacy)', () => {
  it('rejects a predictable legacy TXT replay when the row has a one-time token hash', async () => {
    seedAuth();
    const expectedHash = createHash('sha256')
      .update('grantex-verify=one-time-registration-token')
      .digest('hex');
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_protected',
        verification_token_hash: expectedHash,
      },
    ]);
    mockResolve.mockResolvedValueOnce([['grantex-verify=did:web:protected.example']]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/trust-registry/verify-dns',
      headers: authHeader(),
      payload: { domain: 'protected.example' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('DNS_VERIFICATION_FAILED');
    expect(res.json().message).toBe('DNS TXT verification failed for protected.example');
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('retains the deterministic proof only for a row whose token hash is null', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'treg_legacy',
        verification_token_hash: null,
      },
    ]);
    mockResolve.mockResolvedValueOnce([['grantex-verify=did:web:legacy.example']]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/trust-registry/verify-dns',
      headers: authHeader(),
      payload: { domain: 'legacy.example' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      organizationDID: 'did:web:legacy.example',
      verified: true,
      trustLevel: 'verified',
    });
    expect(sqlText(2)).toContain('verification_token_hash = NULL');
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

// -----------------------------------------------------------------
// GET /v1/trust-registry — every record, across developers. Takes the admin
// key only when TRUST_REGISTRY_ADMIN_LISTING_ENFORCED=true (opt-in); by
// default it keeps the existing developer-key behaviour.
// -----------------------------------------------------------------
describe('GET /v1/trust-registry (admin listing)', () => {
  const adminHeaders = () => ({ authorization: `Bearer ${TEST_ADMIN_API_KEY}` });

  // Two developers' records: the listing is cross-tenant by design, which is
  // why the enforced setting lets only the service administrator read it.
  const acrossDevelopers = () => [
    registryRow('treg_a', {
      developer_id: 'dev_A',
      verification_method: 'dns-txt',
      trust_level: 'verified',
      verified_at: new Date('2026-09-01T00:00:00Z'),
    }),
    registryRow('treg_b', { developer_id: 'dev_B', verification_method: 'pending', verified_at: null }),
  ];

  // The flag is read when the routes are registered, so each setting gets an
  // app of its own. `undefined` removes the variable for the build.
  async function buildWithFlag(value: string | undefined): Promise<FastifyInstance> {
    vi.stubEnv('TRUST_REGISTRY_ADMIN_LISTING_ENFORCED', value);
    try {
      return await buildTestApp();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  describe('enforced (TRUST_REGISTRY_ADMIN_LISTING_ENFORCED=true)', () => {
    let enforced: FastifyInstance;

    beforeAll(async () => {
      enforced = await buildWithFlag('true');
    });

    afterAll(async () => {
      await enforced?.close();
    });

    it('refuses a developer API key with 401 and reads nothing from the registry', async () => {
      seedAuth();
      sqlMock.mockResolvedValueOnce(acrossDevelopers());

      const res = await enforced.inject({ method: 'GET', url: '/v1/trust-registry', headers: authHeader() });

      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ message: 'Unauthorized', code: 'UNAUTHORIZED', requestId: expect.any(String) });
      // Tenant isolation: no query ran, so no other developer's record could leak.
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('refuses a request with no credential or the wrong one', async () => {
      const none = await enforced.inject({ method: 'GET', url: '/v1/trust-registry' });
      expect(none.statusCode).toBe(401);
      expect(none.json().code).toBe('UNAUTHORIZED');

      const wrong = await enforced.inject({
        method: 'GET',
        url: '/v1/trust-registry',
        headers: { authorization: `Bearer ${TEST_ADMIN_API_KEY.slice(0, -1)}x` },
      });
      expect(wrong.statusCode).toBe(401);

      // The key without the Bearer scheme is not the credential either.
      const bare = await enforced.inject({
        method: 'GET',
        url: '/v1/trust-registry',
        headers: { authorization: TEST_ADMIN_API_KEY },
      });
      expect(bare.statusCode).toBe(401);
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('lists every developer\'s records for the admin key', async () => {
      sqlMock.mockResolvedValueOnce(acrossDevelopers());

      const res = await enforced.inject({ method: 'GET', url: '/v1/trust-registry', headers: adminHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        records: [
          {
            organizationDID: 'did:web:treg_a.example',
            verifiedAt: '2026-09-01T00:00:00.000Z',
            verificationMethod: 'dns-txt',
            trustLevel: 'verified',
            domains: ['treg_a.example'],
            name: 'Organization treg_a',
            description: null,
            badges: [],
          },
          {
            organizationDID: 'did:web:treg_b.example',
            verifiedAt: null,
            verificationMethod: 'pending',
            trustLevel: 'basic',
            domains: ['treg_b.example'],
            name: 'Organization treg_b',
            description: null,
            badges: [],
          },
        ],
      });
      // One query, and it is the registry listing: the admin key is never
      // looked up as a developer key.
      expect(sqlMock).toHaveBeenCalledTimes(1);
      expect(sqlText(0)).toMatch(/FROM\s+trust_registry\s+ORDER BY created_at DESC\s+LIMIT 100/);
      // The operator routes' per-address limit.
      expect(res.headers['x-ratelimit-limit']).toBe('20');
    });

    it('fails closed with 503 when ADMIN_API_KEY is not configured', async () => {
      const original = config.adminApiKey;
      (config as { adminApiKey: string }).adminApiKey = '';
      try {
        // Neither an empty bearer value, a developer key nor the old admin key gets through.
        const empty = await enforced.inject({ method: 'GET', url: '/v1/trust-registry', headers: { authorization: 'Bearer ' } });
        expect(empty.statusCode).toBe(503);
        expect(empty.json().code).toBe('SERVICE_UNAVAILABLE');

        seedAuth();
        const developer = await enforced.inject({ method: 'GET', url: '/v1/trust-registry', headers: authHeader() });
        expect(developer.statusCode).toBe(503);

        const formerAdmin = await enforced.inject({
          method: 'GET',
          url: '/v1/trust-registry',
          headers: { authorization: `Bearer ${original}` },
        });
        expect(formerAdmin.statusCode).toBe(503);
      } finally {
        (config as { adminApiKey: string }).adminApiKey = original;
      }
      // The developer seed was never consumed: nothing was read.
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('leaves the public single-record lookup and the verify-dns route as they were', async () => {
      sqlMock.mockResolvedValueOnce([registryRow('treg_a', { verification_method: 'dns-txt', verified_at: null })]);
      sqlMock.mockResolvedValueOnce([]);
      const lookup = await enforced.inject({ method: 'GET', url: '/v1/trust-registry/did:web:treg_a.example' });
      expect(lookup.statusCode).toBe(200);

      // verify-dns still takes a developer key, not the admin key.
      const verify = await enforced.inject({
        method: 'POST',
        url: '/v1/trust-registry/verify-dns',
        headers: adminHeaders(),
        payload: { domain: 'treg_a.example' },
      });
      expect(verify.statusCode).toBe(401);
    });
  });

  describe('flag', () => {
    it('is enforced only when TRUST_REGISTRY_ADMIN_LISTING_ENFORCED is exactly true', () => {
      expect(trustRegistryAdminListingEnforced({})).toBe(false);
      expect(trustRegistryAdminListingEnforced({ TRUST_REGISTRY_ADMIN_LISTING_ENFORCED: 'false' })).toBe(false);
      expect(trustRegistryAdminListingEnforced({ TRUST_REGISTRY_ADMIN_LISTING_ENFORCED: 'true' })).toBe(true);
      // Parsed like the service's other boolean flags in config.ts: exact and
      // case-sensitive. Anything else leaves the existing behaviour in place.
      for (const value of ['', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
        expect(trustRegistryAdminListingEnforced({ TRUST_REGISTRY_ADMIN_LISTING_ENFORCED: value }), value).toBe(false);
      }
    });

    // Off keeps the existing behaviour: standard developer API key auth and
    // the plan budget, with the admin key not a credential on this route.
    const keepsExistingBehaviour = (getApp: () => FastifyInstance) => {
      it('lists for any developer API key, as before', async () => {
        seedAuth();
        sqlMock.mockResolvedValueOnce(acrossDevelopers());

        const res = await getApp().inject({ method: 'GET', url: '/v1/trust-registry', headers: authHeader() });

        expect(res.statusCode).toBe(200);
        expect(res.json().records.map((r: { organizationDID: string }) => r.organizationDID))
          .toEqual(['did:web:treg_a.example', 'did:web:treg_b.example']);
      });

      it('takes standard developer auth, so the admin key is not a credential there', async () => {
        const res = await getApp().inject({ method: 'GET', url: '/v1/trust-registry', headers: adminHeaders() });
        expect(res.statusCode).toBe(401);
        expect(res.json().message).toBe('Invalid API key');
      });
    };

    describe('default (TRUST_REGISTRY_ADMIN_LISTING_ENFORCED unset)', () => {
      let byDefault: FastifyInstance;

      beforeAll(async () => {
        byDefault = await buildWithFlag(undefined);
      });

      afterAll(async () => {
        await byDefault?.close();
      });

      it('reads the unset variable as off', () => {
        vi.stubEnv('TRUST_REGISTRY_ADMIN_LISTING_ENFORCED', undefined);
        try {
          expect(trustRegistryAdminListingEnforced()).toBe(false);
        } finally {
          vi.unstubAllEnvs();
        }
      });

      keepsExistingBehaviour(() => byDefault);
    });

    describe('off (TRUST_REGISTRY_ADMIN_LISTING_ENFORCED=false)', () => {
      let off: FastifyInstance;

      beforeAll(async () => {
        off = await buildWithFlag('false');
      });

      afterAll(async () => {
        await off?.close();
      });

      keepsExistingBehaviour(() => off);
    });

    describe('a value other than true (TRUST_REGISTRY_ADMIN_LISTING_ENFORCED=TRUE)', () => {
      let mistyped: FastifyInstance;

      beforeAll(async () => {
        mistyped = await buildWithFlag('TRUE');
      });

      afterAll(async () => {
        await mistyped?.close();
      });

      keepsExistingBehaviour(() => mistyped);
    });
  });
});
