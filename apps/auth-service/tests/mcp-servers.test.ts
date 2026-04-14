import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, seedAuth, authHeader, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ---------------------------------------------------------------------------
// GET /v1/mcp/servers — public listing
// ---------------------------------------------------------------------------
describe('GET /v1/mcp/servers', () => {
  it('returns list without auth (skipAuth)', async () => {
    // Count query
    sqlMock.mockResolvedValueOnce([{ total: 1 }]);
    // Data query
    sqlMock.mockResolvedValueOnce([
      {
        id: 'mcp_srv_01HABC',
        name: 'Google Calendar MCP',
        description: 'Manages calendar events for AI agents',
        category: 'productivity',
        scopes: ['calendar:read', 'calendar:write'],
        certified: true,
        certified_at: new Date('2026-03-15'),
        certification_level: 'gold',
        npm_package: '@acme/mcp-calendar',
        weekly_active_agents: 1423,
        stars: 234,
        server_url: null,
        auth_endpoint: null,
        created_at: new Date('2026-03-01'),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/servers',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].serverId).toBe('mcp_srv_01HABC');
    expect(body.data[0].name).toBe('Google Calendar MCP');
    expect(body.data[0].certified).toBe(true);
    expect(body.data[0].certificationLevel).toBe('gold');
    expect(body.meta.total).toBe(1);
  });

  it('filters by certified=true', async () => {
    // Count query
    sqlMock.mockResolvedValueOnce([{ total: 0 }]);
    // Data query
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/servers?certified=true',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(res.json().meta.total).toBe(0);
  });

  it('filters by category', async () => {
    // Count query
    sqlMock.mockResolvedValueOnce([{ total: 1 }]);
    // Data query
    sqlMock.mockResolvedValueOnce([
      {
        id: 'mcp_srv_02DATA',
        name: 'BigQuery MCP',
        description: 'Query BigQuery datasets',
        category: 'data',
        scopes: ['bigquery:read'],
        certified: false,
        certified_at: null,
        certification_level: null,
        npm_package: null,
        weekly_active_agents: 100,
        stars: 50,
        server_url: null,
        auth_endpoint: null,
        created_at: new Date('2026-03-10'),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/servers?category=data',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].category).toBe('data');
  });

  it('searches by name', async () => {
    // Count query
    sqlMock.mockResolvedValueOnce([{ total: 1 }]);
    // Data query
    sqlMock.mockResolvedValueOnce([
      {
        id: 'mcp_srv_03SRCH',
        name: 'Slack MCP',
        description: 'Send messages via Slack',
        category: 'communication',
        scopes: ['slack:write'],
        certified: false,
        certified_at: null,
        certification_level: null,
        npm_package: '@acme/mcp-slack',
        weekly_active_agents: 500,
        stars: 120,
        server_url: null,
        auth_endpoint: null,
        created_at: new Date('2026-03-05'),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/servers?q=Slack',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].name).toBe('Slack MCP');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/mcp/servers — register a server
// ---------------------------------------------------------------------------
describe('POST /v1/mcp/servers', () => {
  it('creates server (201)', async () => {
    seedAuth();
    // Insert returns created_at
    sqlMock.mockResolvedValueOnce([{ created_at: new Date('2026-04-14T00:00:00Z') }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mcp/servers',
      headers: authHeader(),
      payload: {
        name: 'My MCP Server',
        description: 'A cool MCP server',
        category: 'productivity',
        scopes: ['calendar:read'],
        npmPackage: '@test/mcp-server',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.serverId).toMatch(/^mcp_srv_/);
    expect(body.name).toBe('My MCP Server');
    expect(body.category).toBe('productivity');
    expect(body.certified).toBe(false);
    expect(body.scopes).toEqual(['calendar:read']);
    expect(body.status).toBe('active');
    expect(body.createdAt).toBe('2026-04-14T00:00:00.000Z');
  });

  it('rejects missing name (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mcp/servers',
      headers: authHeader(),
      payload: {
        category: 'productivity',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects invalid category (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mcp/servers',
      headers: authHeader(),
      payload: {
        name: 'Bad Category Server',
        category: 'invalid_cat',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain('Invalid category');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/mcp/servers/:serverId — server detail (public)
// ---------------------------------------------------------------------------
describe('GET /v1/mcp/servers/:serverId', () => {
  it('returns server detail (public)', async () => {
    // JOIN query
    sqlMock.mockResolvedValueOnce([
      {
        id: 'mcp_srv_01HABC',
        name: 'Google Calendar MCP',
        description: 'Manages calendar events',
        category: 'productivity',
        scopes: ['calendar:read'],
        certified: true,
        certified_at: new Date('2026-03-15'),
        certification_level: 'gold',
        server_url: 'https://mcp.example.com',
        auth_endpoint: 'https://mcp.example.com/auth',
        npm_package: '@acme/mcp-calendar',
        weekly_active_agents: 1423,
        stars: 234,
        status: 'active',
        created_at: new Date('2026-03-01'),
        updated_at: new Date('2026-03-15'),
        publisher_id: 'dev_PUB01',
        publisher_name: 'Acme Corp',
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/servers/mcp_srv_01HABC',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serverId).toBe('mcp_srv_01HABC');
    expect(body.publisher.id).toBe('dev_PUB01');
    expect(body.publisher.name).toBe('Acme Corp');
    expect(body.certificationLevel).toBe('gold');
  });

  it('returns 404 for unknown server', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/servers/mcp_srv_NONEXISTENT',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/mcp/certification/apply — apply for certification
// ---------------------------------------------------------------------------
describe('POST /v1/mcp/certification/apply', () => {
  it('creates certification (202)', async () => {
    seedAuth();
    // Server ownership check
    sqlMock.mockResolvedValueOnce([{ id: 'mcp_srv_01HABC' }]);
    // Insert certification
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mcp/certification/apply',
      headers: authHeader(),
      payload: {
        serverId: 'mcp_srv_01HABC',
        requestedLevel: 'gold',
      },
    });

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.certificationId).toMatch(/^cert_/);
    expect(body.serverId).toBe('mcp_srv_01HABC');
    expect(body.requestedLevel).toBe('gold');
    expect(body.status).toBe('pending_conformance_test');
    expect(body.conformancePassed).toBe(0);
    expect(body.conformanceTotal).toBe(13);
  });

  it('rejects server not owned by developer (404)', async () => {
    seedAuth();
    // Server ownership check returns empty
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mcp/certification/apply',
      headers: authHeader(),
      payload: {
        serverId: 'mcp_srv_NOT_MINE',
        requestedLevel: 'bronze',
      },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });

  it('rejects invalid certification level (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/mcp/certification/apply',
      headers: authHeader(),
      payload: {
        serverId: 'mcp_srv_01HABC',
        requestedLevel: 'platinum',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
    expect(res.json().message).toContain('Invalid requestedLevel');
  });
});

// ---------------------------------------------------------------------------
// GET /v1/mcp/certification/:certId — certification status
// ---------------------------------------------------------------------------
describe('GET /v1/mcp/certification/:certId', () => {
  it('returns certification status', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([
      {
        id: 'cert_01CERTID',
        server_id: 'mcp_srv_01HABC',
        requested_level: 'gold',
        status: 'pending_conformance_test',
        conformance_results: {},
        conformance_passed: 0,
        conformance_total: 13,
        reviewed_at: null,
        reviewer_notes: null,
        created_at: new Date('2026-03-20'),
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/certification/cert_01CERTID',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.certificationId).toBe('cert_01CERTID');
    expect(body.serverId).toBe('mcp_srv_01HABC');
    expect(body.requestedLevel).toBe('gold');
    expect(body.status).toBe('pending_conformance_test');
    expect(body.conformancePassed).toBe(0);
    expect(body.conformanceTotal).toBe(13);
  });

  it('returns 404 for unknown certification', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/mcp/certification/cert_NONEXISTENT',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
