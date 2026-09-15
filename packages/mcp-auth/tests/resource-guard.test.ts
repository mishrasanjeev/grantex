import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import * as jose from 'jose';
import { requireMcpAuth, protectedResourceMetadataHandler } from '../src/middleware/express.js';
import type { McpAuthRequest, RequireMcpAuthOptions } from '../src/middleware/express.js';
import { requireMcpAuth as requireMcpAuthHono } from '../src/middleware/hono.js';
import { filterToolsForGrant } from '../src/resource/guard.js';
import { toolPolicyFromManifests, toolPolicyFromScopes } from '../src/resource/tool-policy.js';
import type { LoadedManifest } from '../src/resource/tool-policy.js';
import { decisionRequiredChallenge, formatBearerChallenge } from '../src/resource/challenge.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const METADATA = 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

// Plain manifest data in the 0.6 shape (string and object tool values).
const ACME_KYB: LoadedManifest = {
  connector: 'acme_kyb',
  version: '1.0.0',
  tools: {
    resolve_business: { permission: 'read', allowed_purposes: ['aml.cdd.*'], caps: { per_hour: 200 } },
    screen_person: 'read',
    monitor_enroll: { permission: 'write', allowed_purposes: ['aml.cdd.ongoing'] },
    case_decision: { permission: 'write', requires_decision: true, four_eyes_on: ['decline'] },
  },
};

let privateKey: jose.CryptoKey;
let jwks: Server;
let issuer: string;

beforeAll(async () => {
  const pair = await jose.generateKeyPair('ES256');
  privateKey = pair.privateKey;
  const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'guard', alg: 'ES256', use: 'sig' };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const address = jwks.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

async function token(claims: Record<string, unknown> = {}, jti: string | null = 'grnt_guard'): Promise<string> {
  const builder = new jose.SignJWT({ scp: ['tool:acme_kyb:read'], aud: RESOURCE, sub: 'client-a', ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'guard' })
    .setIssuer(issuer)
    .setIssuedAt();
  if (claims['exp'] === undefined) builder.setExpirationTime('1h');
  if (jti !== null) builder.setJti(jti);
  return builder.sign(privateKey);
}

function call(name: string, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { case_id: 'case_0001' } } };
}

interface Outcome {
  status: number;
  challenge: string | null;
  body: Record<string, unknown>;
}

/** Runs the Express middleware on a real HTTP server, parsing JSON first as express.json() would. */
async function express(
  options: Partial<RequireMcpAuthOptions>,
  request: { authorization?: string; body?: unknown; parse?: boolean; method?: string },
  downstream?: (req: McpAuthRequest, res: ServerResponse) => void,
): Promise<Outcome> {
  const mw = requireMcpAuth({ issuer, audience: RESOURCE, ...options } as RequireMcpAuthOptions);
  const server = createServer((raw: IncomingMessage, res: ServerResponse) => {
    const req = raw as McpAuthRequest;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (request.parse !== false && chunks.length > 0) req.body = JSON.parse(Buffer.concat(chunks).toString());
      mw(req, res, (err?: unknown) => {
        if (err) {
          res.writeHead(599);
          res.end(JSON.stringify({ downstreamError: String(err) }));
          return;
        }
        if (downstream) {
          // Express wraps each layer in try/catch and routes a throw to its
          // error handler (500); mirror that here.
          try {
            return downstream(req, res);
          } catch {
            res.writeHead(500);
            res.end('{}');
            return;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sub: req.mcpGrant?.sub }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: request.method ?? (request.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(request.authorization !== undefined ? { authorization: request.authorization } : {}),
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, challenge: response.headers.get('www-authenticate'), body: text ? JSON.parse(text) : {} };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('resource server: token validation and challenges', () => {
  it('requires an audience at construction', () => {
    expect(() => requireMcpAuth({ issuer } as RequireMcpAuthOptions)).toThrow(/`audience` is required/);
    expect(() => requireMcpAuthHono({ issuer, audience: [] })).toThrow(/`audience` is required/);
  });

  it('401 without a token points at the protected-resource metadata (RFC 9728 §5.1)', async () => {
    const outcome = await express({}, {});
    expect(outcome.status).toBe(401);
    expect(outcome.challenge).toBe(`Bearer resource_metadata="${METADATA}"`);
  });

  it('401 with error="invalid_token" for an expired token or one for another audience', async () => {
    for (const bad of [await token({ exp: Math.floor(Date.now() / 1000) - 60 }), await token({ aud: 'https://other.example.com/mcp' })]) {
      const outcome = await express({}, { authorization: `Bearer ${bad}` });
      expect(outcome.status).toBe(401);
      expect(outcome.challenge).toContain('error="invalid_token"');
      expect(outcome.challenge).toContain(`resource_metadata="${METADATA}"`);
    }
  });

  it('403 insufficient_scope carries every required scope in one challenge', async () => {
    const outcome = await express({ scopes: ['tool:acme_kyb:read', 'files:write'] }, { authorization: `Bearer ${await token()}` });
    expect(outcome.status).toBe(403);
    expect(outcome.challenge).toMatch(/^Bearer error="insufficient_scope", scope="tool:acme_kyb:read files:write", resource_metadata="/);
  });

  it('uses an explicit resourceMetadataUrl when given', async () => {
    const outcome = await express({ resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource' }, {});
    expect(outcome.challenge).toBe('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"');
  });
});

describe('resource server: a tool outside the grant is refused, not hidden', () => {
  const tools = toolPolicyFromManifests([ACME_KYB]);

  it('allows a granted tool', async () => {
    const outcome = await express({ tools }, { authorization: `Bearer ${await token()}`, body: call('resolve_business') });
    expect(outcome.status).toBe(200);
  });

  it('refuses an ungranted tool with 403, the reason and the scope that would grant it', async () => {
    const outcome = await express({ tools }, { authorization: `Bearer ${await token()}`, body: call('monitor_enroll') });
    expect(outcome.status).toBe(403);
    expect(outcome.body).toMatchObject({
      error: 'insufficient_scope',
      reason: 'tool_not_granted',
      tool: 'monitor_enroll',
      required_scopes: ['tool:acme_kyb:write'],
    });
    expect(outcome.challenge).toContain('error="insufficient_scope"');
    expect(outcome.challenge).toContain('scope="tool:acme_kyb:write"');
  });

  it('refuses a tool no manifest declares (manifest_unknown_tool)', async () => {
    const outcome = await express({ tools }, { authorization: `Bearer ${await token({ scp: ['tool:acme_kyb:admin'] })}`, body: call('delete_everything') });
    expect(outcome.status).toBe(403);
    expect(outcome.body).toMatchObject({ reason: 'manifest_unknown_tool', tool: 'delete_everything' });
  });

  it('refuses a whole batch when any call in it is not granted', async () => {
    const outcome = await express({ tools }, {
      authorization: `Bearer ${await token()}`,
      body: [call('resolve_business', 1), call('monitor_enroll', 2)],
    });
    expect(outcome.status).toBe(403);
    expect(outcome.body['tool']).toBe('monitor_enroll');
  });

  it('honours the permission hierarchy (a write grant covers read tools)', async () => {
    const outcome = await express({ tools }, { authorization: `Bearer ${await token({ scp: ['tool:acme_kyb:write'] })}`, body: call('screen_person') });
    expect(outcome.status).toBe(200);
  });

  it('lets non-tool methods through and refuses malformed tool calls', async () => {
    const auth = `Bearer ${await token()}`;
    expect((await express({ tools }, { authorization: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status).toBe(200);
    expect((await express({ tools }, { authorization: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } })).status).toBe(400);
    expect((await express({ tools }, { authorization: auth, body: { jsonrpc: '2.0', id: 1, method: 'tools/call' } })).status).toBe(400);
  });

  it('fails closed when the host did not parse the body', async () => {
    const outcome = await express({ tools }, { authorization: `Bearer ${await token()}`, body: call('resolve_business'), parse: false });
    expect(outcome.status).toBe(500);
    expect(outcome.body).toMatchObject({ error: 'server_error' });
  });

  it('works with an explicit scope map as well as manifests', async () => {
    const explicit = toolPolicyFromScopes({ read_file: ['files:read'], write_file: ['files:read', 'files:write'] });
    const auth = `Bearer ${await token({ scp: ['files:read'] })}`;
    expect((await express({ tools: explicit }, { authorization: auth, body: call('read_file') })).status).toBe(200);
    const refused = await express({ tools: explicit }, { authorization: auth, body: call('write_file') });
    expect(refused.status).toBe(403);
    expect(refused.challenge).toContain('scope="files:read files:write"');
  });

  it('filterToolsForGrant hides ungranted tools from listings', () => {
    const listed = [{ name: 'resolve_business' }, { name: 'monitor_enroll' }, { name: 'undeclared' }];
    expect(filterToolsForGrant(listed, ['tool:acme_kyb:read'], tools).map((t) => t.name)).toEqual(['resolve_business']);
  });
});

describe('resource server: decision_required extension point', () => {
  const tools = toolPolicyFromManifests([ACME_KYB]);
  const writeGrant = () => token({ scp: ['tool:acme_kyb:write'] });

  it('refuses a requires_decision tool with the decision_required challenge when no verifier is configured', async () => {
    const outcome = await express({ tools }, { authorization: `Bearer ${await writeGrant()}`, body: call('case_decision') });
    expect(outcome.status).toBe(403);
    expect(outcome.challenge).toBe(
      'Bearer error="insufficient_authorization", decision_required="acme_kyb:case_decision", '
      + `resource_metadata="${METADATA}", error_description="Tool \\"case_decision\\" requires a decision grant approved by a person"`,
    );
    expect(outcome.body).toMatchObject({ error: 'insufficient_authorization', reason: 'decision_required', tool: 'case_decision' });
  });

  it('passes the call to the verifier and follows its outcome', async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ status: 'valid' })
      .mockResolvedValueOnce({ status: 'invalid', subReason: 'expired' })
      .mockRejectedValueOnce(new Error('verifier crashed'));
    const decisions = { verify };
    const auth = `Bearer ${await writeGrant()}`;

    expect((await express({ tools, decisions }, { authorization: auth, body: call('case_decision') })).status).toBe(200);
    expect(verify.mock.calls[0]![0]).toMatchObject({
      requirement: { connector: 'acme_kyb', tool: 'case_decision', requiresDecision: true, fourEyesOn: ['decline'] },
      arguments: { case_id: 'case_0001' },
    });

    const invalid = await express({ tools, decisions }, { authorization: auth, body: call('case_decision') });
    expect(invalid.status).toBe(403);
    expect(invalid.body).toMatchObject({ reason: 'decision_invalid', sub_reason: 'expired' });
    expect(invalid.challenge).toContain('decision_required="acme_kyb:case_decision"');

    const crashed = await express({ tools, decisions, decisionUri: 'https://approvals.example.com/decisions' }, { authorization: auth, body: call('case_decision') });
    expect(crashed.status).toBe(403);
    expect(crashed.challenge).toContain('decision_uri="https://approvals.example.com/decisions"');
    expect(crashed.body).toMatchObject({ reason: 'decision_invalid', sub_reason: 'verification_failed' });
  });

  it('checks the scope before the decision: an ungranted decision tool is tool_not_granted', async () => {
    const decisions = { verify: vi.fn().mockResolvedValue({ status: 'valid' }) };
    const outcome = await express({ tools, decisions }, { authorization: `Bearer ${await token()}`, body: call('case_decision') });
    expect(outcome.body).toMatchObject({ reason: 'tool_not_granted' });
    expect(decisions.verify).not.toHaveBeenCalled();
  });

  it('builds the challenge with a decision_uri and escapes quoted values', () => {
    expect(decisionRequiredChallenge({ tool: 'case_decision', connector: 'acme_kyb', decisionUri: 'https://approvals.example.com/decisions', description: 'x' }))
      .toBe('Bearer error="insufficient_authorization", decision_required="acme_kyb:case_decision", decision_uri="https://approvals.example.com/decisions", error_description="x"');
    expect(formatBearerChallenge({ error_description: 'a "quoted" \\ value\r\nInjected: header' }))
      .toBe('Bearer error_description="a \\"quoted\\" \\\\ value  Injected: header"');
    expect(() => formatBearerChallenge({ 'bad name': 'x' })).toThrow();
  });
});

describe('resource server: revocation', () => {
  it('refuses a revoked token, a token without jti, and fails closed when revocation state is unavailable', async () => {
    const revocations = { isTokenRevoked: vi.fn(async (jti: string) => jti === 'grnt_revoked') };
    expect((await express({ revocations }, { authorization: `Bearer ${await token({}, 'grnt_live')}` })).status).toBe(200);
    const revoked = await express({ revocations }, { authorization: `Bearer ${await token({}, 'grnt_revoked')}` });
    expect(revoked.status).toBe(401);
    expect(revoked.challenge).toContain('error="invalid_token"');
    expect((await express({ revocations }, { authorization: `Bearer ${await token({}, null)}` })).status).toBe(401);

    const unavailable = { isTokenRevoked: async () => { throw new Error('redis down'); } };
    const outcome = await express({ revocations: unavailable }, { authorization: `Bearer ${await token()}` });
    expect(outcome.status).toBe(503);
  });
});

describe('resource server: downstream errors are not authorization failures', () => {
  it('Express: an error thrown after next() is not turned into a 401', async () => {
    const outcome = await express({}, { authorization: `Bearer ${await token()}` }, () => {
      throw new Error('handler bug');
    });
    expect(outcome.status).toBe(500);
  });

  it('Hono: an error from next() propagates', async () => {
    const mw = requireMcpAuthHono({ issuer, audience: RESOURCE });
    const c = {
      req: { header: (name: string) => (name.toLowerCase() === 'authorization' ? auth : undefined) },
      set: () => {},
      json: (data: unknown, status?: number) => new Response(JSON.stringify(data), { status: status ?? 200 }),
    };
    const auth = `Bearer ${await token()}`;
    await expect(mw(c, async () => { throw new Error('handler bug'); })).rejects.toThrow('handler bug');
  });

  it('Hono: enforces tools with the body it reads and returns the challenge header', async () => {
    const mw = requireMcpAuthHono({ issuer, audience: RESOURCE, tools: toolPolicyFromManifests([ACME_KYB]) });
    const auth = `Bearer ${await token()}`;
    let captured: { status?: number; headers?: Record<string, string>; data?: unknown } = {};
    const c = {
      req: {
        method: 'POST',
        header: (name: string) => (name.toLowerCase() === 'authorization' ? auth : undefined),
        json: async () => call('monitor_enroll'),
      },
      set: () => {},
      json: (data: unknown, status?: number, headers?: Record<string, string>) => {
        captured = { data, ...(status !== undefined ? { status } : {}), ...(headers !== undefined ? { headers } : {}) };
        return new Response(JSON.stringify(data), { status: status ?? 200 });
      },
    };
    const next = vi.fn();
    await mw(c, next);
    expect(next).not.toHaveBeenCalled();
    expect(captured.status).toBe(403);
    expect(captured.headers?.['www-authenticate']).toContain('scope="tool:acme_kyb:write"');
  });
});

describe('tool policy from manifests', () => {
  it('rejects requires_decision on a read tool, duplicate tool names and invalid permissions', () => {
    expect(() => toolPolicyFromManifests([{ connector: 'acme_kyb', tools: { look: { permission: 'read', requires_decision: true } } }]))
      .toThrow(/requires_decision on a read tool/);
    expect(() => toolPolicyFromManifests([
      { connector: 'acme_kyb', tools: { lookup: 'read' } },
      { connector: 'acme_registry', tools: { lookup: 'read' } },
    ])).toThrow(/declared by more than one manifest/);
    expect(() => toolPolicyFromManifests([{ connector: 'acme_kyb', tools: { lookup: 'owner' as never } }])).toThrow(/invalid permission/);
    expect(() => toolPolicyFromManifests([])).toThrow(/at least one manifest/);
  });

  it('can namespace tool names by connector to avoid collisions', () => {
    const policy = toolPolicyFromManifests(
      [{ connector: 'acme_kyb', tools: { lookup: 'read' } }, { connector: 'acme_registry', tools: { lookup: 'write' } }],
      { toolName: (connector, tool) => `${connector}.${tool}` },
    );
    expect(policy.requirementFor('acme_registry.lookup')?.requiredScopes).toEqual(['tool:acme_registry:write']);
    expect(policy.scopesSupported).toEqual(['tool:acme_kyb:read', 'tool:acme_registry:write']);
  });
});

describe('protected resource metadata handler', () => {
  it('serves RFC 9728 metadata for an MCP server hosted elsewhere', async () => {
    const handler = protectedResourceMetadataHandler({
      resource: RESOURCE,
      authorizationServers: ['https://auth.example.com'],
      scopesSupported: ['tool:acme_kyb:read', 'offline_access'],
    });
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`)).json();
      expect(body).toEqual({
        resource: RESOURCE,
        authorization_servers: ['https://auth.example.com'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['tool:acme_kyb:read'],
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(() => protectedResourceMetadataHandler({ resource: RESOURCE, authorizationServers: [] })).toThrow(/at least one/);
  });
});
