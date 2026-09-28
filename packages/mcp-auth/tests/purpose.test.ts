/**
 * The grant purpose shown on the consent page is the purpose Grantex binds
 * the grant to, and nothing is shown that the grant cannot carry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Grantex } from '@grantex/sdk';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../src/server.js';
import { InMemoryStorage } from '../src/storage/memory.js';
import type { McpAuthConfig } from '../src/types.js';
import type { LoadedManifest } from '../src/resource/tool-policy.js';
import {
  TEST_CHALLENGE,
  TEST_CLIENT_ID,
  TEST_REDIRECT_URI,
  TEST_RESOURCE,
  asGrantex,
  clientRecord,
  mockGrantex,
  seededStorage,
  submitConsent,
} from './helpers.js';

const ISSUER = 'https://auth.example.com';
const PURPOSE = 'aml.cdd.onboarding';

const ACME_KYB: LoadedManifest = {
  connector: 'acme_kyb',
  tools: {
    resolve_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'] },
    monitor_enroll: { permission: 'write' },
  },
};

type Overrides = { [K in keyof McpAuthConfig]?: McpAuthConfig[K] | undefined };

async function build(grantex: McpAuthConfig['grantex'], overrides: Overrides = {}): Promise<FastifyInstance> {
  return createMcpAuthServer({
    resolvePrincipal: async () => ({ principalId: 'principal-1' }),
    grantex,
    agentId: 'agent-1',
    issuer: ISSUER,
    resource: TEST_RESOURCE,
    manifests: [ACME_KYB],
    // `profile` names no connector, so a purpose has nothing to bind to.
    scopes: ['profile'],
    grant: { purpose: PURPOSE },
    storage: await seededStorage(clientRecord()),
    ...overrides,
  } as McpAuthConfig);
}

/** GET /authorize, then approve the consent page the way a browser does. */
async function approve(app: FastifyInstance, scope = 'tool:acme_kyb:read') {
  const page = await app.inject({
    method: 'GET',
    url: '/authorize',
    query: {
      response_type: 'code',
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      code_challenge: TEST_CHALLENGE,
      code_challenge_method: 'S256',
      scope,
      state: 'client-state',
    },
  });
  expect(page.statusCode).toBe(200);
  return submitConsent(app, page, 'approve', ISSUER);
}

function setCookies(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['set-cookie'] ?? '');
}

function errorBody(response: { body: string }): { error?: string; error_description?: string } {
  return JSON.parse(response.body) as { error?: string; error_description?: string };
}

/**
 * A stand-in for the Grantex API, reached through the real SDK over HTTP, so
 * these tests see exactly what the SDK sends and the errors it throws.
 */
async function grantexApi(answer: (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }) {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ path: req.url, ...body });
      const reply = answer(body);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  const client = new Grantex({ apiKey: 'gx_test_placeholder', baseUrl: `http://127.0.0.1:${port}`, maxRetries: 0 });
  return { client, requests };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Collects what the server reports to the operator through `warn`. */
function operatorLog(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message: string) => { messages.push(message); }, messages };
}

/** POST /v1/authorize as the auth service answers it (201, echoing the purpose). */
function created(body: Record<string, unknown>) {
  return {
    status: 201,
    body: {
      authRequestId: 'areq_01',
      principalId: 'principal-1',
      consentUrl: 'https://grantex.example.com/consent?req=areq_01',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...(body['purpose'] !== undefined ? { purpose: body['purpose'] } : {}),
    },
  };
}

describe('the grant purpose reaches Grantex', () => {
  it('sends grant.purpose with the upstream authorization request', async () => {
    const grantex = mockGrantex();
    const app = await build(asGrantex(grantex));
    const result = await approve(app);
    expect(result.statusCode).toBe(303);
    expect(result.headers['location']).toBe('https://grantex.example.com/consent');
    expect(grantex.authorize).toHaveBeenCalledTimes(1);
    expect(grantex.authorize.mock.calls[0]![0]).toMatchObject({
      purpose: PURPOSE,
      agentId: 'agent-1',
      scopes: ['tool:acme_kyb:read'],
      audience: TEST_RESOURCE,
    });
  });

  it('reaches POST /v1/authorize in the request body through the SDK', async () => {
    const api = await grantexApi(created);
    const app = await build(api.client);
    const result = await approve(app);
    expect(result.statusCode).toBe(303);
    expect(result.headers['location']).toBe('https://grantex.example.com/consent?req=areq_01');
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      path: '/v1/authorize',
      purpose: PURPOSE,
      principalId: 'principal-1',
      scopes: ['tool:acme_kyb:read'],
    });
  });

  it('sends no purpose when none is configured', async () => {
    const grantex = mockGrantex();
    const app = await build(asGrantex(grantex), { grant: { duration: '8h' } });
    expect((await approve(app)).statusCode).toBe(303);
    expect(grantex.authorize.mock.calls[0]![0]).not.toHaveProperty('purpose');
  });

  it('refuses the authorization when Grantex does not confirm the purpose', async () => {
    // A Grantex server that predates purpose-bound grants ignores the field
    // and answers without it: the grant would not carry the purpose shown.
    const api = await grantexApi((body) => {
      const { purpose: _ignored, ...rest } = body;
      return created(rest);
    });
    const log = operatorLog();
    const app = await build(api.client, { warn: log.warn });
    const result = await approve(app);
    expect(result.statusCode).toBe(502);
    expect(errorBody(result)).toMatchObject({ error: 'server_error' });
    expect(errorBody(result).error_description).toMatch(/did not confirm the purpose/);
    expect(result.headers['location']).toBeUndefined();
    expect(setCookies(result)).not.toMatch(/mcp_auth_callback_/);
    // The operator is told why every authorization now fails.
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toContain(`did not confirm grant.purpose "${PURPOSE}"`);
    expect(log.messages[0]).toContain('may not support purpose-bound grants');
  });
});

describe('a purpose Grantex refuses', () => {
  it('reaches the client as invalid_scope when the requested scopes name no connector', async () => {
    // POST /v1/authorize refuses a purpose whose scopes reach no connector
    // (resolveRequestedPurpose in the auth service) with 400 INVALID_PURPOSE.
    const api = await grantexApi((body) => {
      const scopes = body['scopes'] as string[];
      if (!scopes.some((scope) => scope.startsWith('tool:'))) {
        return {
          status: 400,
          body: { message: 'purpose requires at least one tool:<connector>:<permission> scope', code: 'INVALID_PURPOSE', requestId: 'req_upstream_7' },
        };
      }
      return created(body);
    });
    const log = operatorLog();
    const app = await build(api.client, { warn: log.warn });
    const result = await approve(app, 'profile');

    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ purpose: PURPOSE, scopes: ['profile'] });
    // Not the generic "upstream authorization request failed": the client is
    // told which parameter to change, on its verified redirect URI.
    expect(result.statusCode).toBe(303);
    const location = new URL(String(result.headers['location']));
    expect(location.origin + location.pathname).toBe(TEST_REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('state')).toBe('client-state');
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('code')).toBeNull();
    const description = location.searchParams.get('error_description') ?? '';
    expect(description).toContain(PURPOSE);
    expect(description).toContain('tool:<connector>:<permission>');
    // Fixed text, never the upstream body.
    expect(String(result.headers['location'])).not.toContain('req_upstream_7');
    expect(setCookies(result)).not.toMatch(/mcp_auth_callback_/);
    // The operator log carries Grantex's reason, code and request id.
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toContain(`Grantex refused grant.purpose "${PURPOSE}" for scopes [profile]`);
    expect(log.messages[0]).toContain('400 INVALID_PURPOSE, request req_upstream_7');
    expect(log.messages[0]).toContain('purpose requires at least one tool:<connector>:<permission> scope');
  });

  it('a well-formed purpose outside the vocabulary passes start-up, then refuses every authorization after consent', async () => {
    // mcp-auth checks only the syntax, since Grantex publishes no vocabulary
    // in its metadata. The auth service's isKnownPurpose refuses the term.
    const vocabulary = ['aml.cdd.onboarding', 'aml.cdd.ongoing', 'aml.screening', 'procurement.vendor_onboarding', 'payments.payout'];
    const api = await grantexApi((body) => {
      const purpose = body['purpose'];
      if (typeof purpose === 'string' && !vocabulary.includes(purpose) && !purpose.startsWith('x-')) {
        return {
          status: 400,
          body: { message: `purpose must be one of ${vocabulary.join(', ')} or a private term x-<org>.<term>`, code: 'INVALID_PURPOSE' },
        };
      }
      return created(body);
    });
    const log = operatorLog();
    const app = await build(api.client, { grant: { purpose: 'marketing.analytics' }, warn: log.warn });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await approve(app);
      expect(result.statusCode).toBe(303);
      const location = new URL(String(result.headers['location']));
      expect(location.searchParams.get('error')).toBe('invalid_scope');
      expect(location.searchParams.get('code')).toBeNull();
      expect(location.searchParams.get('error_description')).toContain('marketing.analytics');
      // The vocabulary list is Grantex's text: it goes to the operator only.
      expect(location.searchParams.get('error_description')).not.toContain('purpose must be one of');
      expect(log.messages).toHaveLength(attempt);
      expect(log.messages[attempt - 1]).toContain('Grantex refused grant.purpose "marketing.analytics" for scopes [tool:acme_kyb:read]');
      expect(log.messages[attempt - 1]).toContain('purpose must be one of aml.cdd.onboarding');
    }
    expect(api.requests).toHaveLength(2);
  });

  it('keeps Grantex\'s reason on one bounded line in the operator log', async () => {
    const api = await grantexApi(() => ({
      status: 400,
      body: { message: `purpose refused\r\nmcp-auth: forged line\u2028${'x'.repeat(1000)}`, code: 'INVALID_PURPOSE', requestId: 'req\n42' },
    }));
    const log = operatorLog();
    const app = await build(api.client, { warn: log.warn });
    expect((await approve(app)).statusCode).toBe(303);
    expect(log.messages).toHaveLength(1);
    const message = log.messages[0]!;
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    expect(message).toContain('purpose refused mcp-auth: forged line');
    expect(message).toContain('request req 42');
    expect(message).toContain('x'.repeat(200));
    expect(message).not.toContain('x'.repeat(301));
  });

  it('reports to console.warn when no warn function is configured', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const api = await grantexApi(() => ({ status: 400, body: { message: 'purpose refused', code: 'INVALID_PURPOSE' } }));
      const app = await build(api.client);
      expect((await approve(app)).statusCode).toBe(303);
      expect(consoleWarn).toHaveBeenCalledTimes(1);
      expect(String(consoleWarn.mock.calls[0]![0])).toContain(`Grantex refused grant.purpose "${PURPOSE}"`);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('a warn function that throws does not change the refusal', async () => {
    const api = await grantexApi(() => ({ status: 400, body: { message: 'purpose refused', code: 'INVALID_PURPOSE' } }));
    const app = await build(api.client, { warn: () => { throw new Error('log sink down'); } });
    const result = await approve(app);
    expect(result.statusCode).toBe(303);
    expect(new URL(String(result.headers['location'])).searchParams.get('error')).toBe('invalid_scope');
  });

  it('other upstream failures stay a generic server_error', async () => {
    const api = await grantexApi(() => ({ status: 400, body: { message: 'Invalid redirectUri: internal detail', code: 'BAD_REQUEST' } }));
    const app = await build(api.client);
    const result = await approve(app);
    expect(result.statusCode).toBe(502);
    expect(errorBody(result)).toEqual({ error: 'server_error', error_description: 'The upstream authorization request failed' });
  });
});

describe('grant.authorizeParams and the purpose', () => {
  it('cannot replace grant.purpose: the authorization is refused before Grantex is called', async () => {
    const grantex = mockGrantex();
    const app = await build(asGrantex(grantex), {
      grant: { purpose: PURPOSE, authorizeParams: () => ({ purpose: 'aml.screening' }) },
    });
    const result = await approve(app);
    expect(result.statusCode).toBe(500);
    expect(errorBody(result)).toMatchObject({ error: 'server_error' });
    expect(errorBody(result).error_description).toMatch(/grant\.authorizeParams/);
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('cannot add a purpose the consent page did not show', async () => {
    const grantex = mockGrantex();
    const app = await build(asGrantex(grantex), {
      grant: { authorizeParams: () => ({ purpose: PURPOSE }) },
    });
    const result = await approve(app);
    expect(result.statusCode).toBe(500);
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  it('may repeat grant.purpose', async () => {
    const grantex = mockGrantex();
    const app = await build(asGrantex(grantex), {
      grant: { purpose: PURPOSE, authorizeParams: () => ({ purpose: PURPOSE, extension: 'kept' }) },
    });
    expect((await approve(app)).statusCode).toBe(303);
    expect(grantex.authorize.mock.calls[0]![0]).toMatchObject({ purpose: PURPOSE, extension: 'kept' });
  });
});

describe('grant.dataRegion', () => {
  it('refuses to start: POST /v1/authorize takes no data region, so the grant could not carry one', async () => {
    for (const grant of [{ dataRegion: 'eu' }, { purpose: PURPOSE, dataRegion: 'us-east', duration: '8h' }]) {
      await expect(build(asGrantex(mockGrantex()), { grant, storage: new InMemoryStorage() }))
        .rejects.toThrow(/grant\.dataRegion is not supported: POST \/v1\/authorize, which this server calls, takes no data region/);
    }
  });
});

describe('warn', () => {
  it('must be a function', async () => {
    await expect(build(asGrantex(mockGrantex()), { warn: 'console' as unknown as McpAuthConfig['warn'], storage: new InMemoryStorage() }))
      .rejects.toThrow(/warn must be a function/);
  });
});
