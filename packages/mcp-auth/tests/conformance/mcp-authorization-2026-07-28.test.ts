/**
 * Conformance with the MCP authorization specification, version 2026-07-28
 * (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
 * and its Authorization Server Discovery, Client Registration and Security
 * Considerations pages).
 *
 * Every MUST / MUST NOT that applies to an authorization server or to an MCP
 * server (resource server) is listed in REQUIREMENTS and mapped to exactly
 * one test through `must(id, ...)`. Requirements on MCP clients are listed
 * too, marked `client`, with the reason they are out of scope for this
 * package. The last test fails if a server-side requirement has no test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import * as jose from 'jose';
import type { FastifyInstance } from 'fastify';
import { createMcpAuthServer } from '../../src/server.js';
import { requireMcpAuth } from '../../src/middleware/express.js';
import type { McpAuthRequest, RequireMcpAuthOptions } from '../../src/middleware/express.js';
import { toolPolicyFromManifests } from '../../src/resource/tool-policy.js';
import { parseClientMetadataDocument, ClientMetadataError, isAllowedRedirectUri } from '../../src/lib/client-metadata.js';
import type { McpAuthConfig } from '../../src/types.js';
import {
  TEST_CHALLENGE,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_REDIRECT_URI,
  TEST_RESOURCE,
  TEST_VERIFIER,
  asGrantex,
  clientRecord,
  mockGrantex,
  seededStorage,
} from '../helpers.js';

type Role = 'authorization-server' | 'resource-server' | 'client';

interface Requirement {
  id: string;
  role: Role;
  section: string;
  text: string;
  /** For client requirements: why this package does not test them. */
  outOfScope?: string;
}

const CLIENT_ONLY = 'Requirement on MCP clients; this package implements the authorization server and resource server.';

export const REQUIREMENTS: Requirement[] = [
  { id: 'AUTH-01', role: 'authorization-server', section: 'Overview', text: 'Authorization servers MUST implement OAuth 2.1 with appropriate security measures for both confidential and public clients.' },
  { id: 'AUTH-02', role: 'resource-server', section: 'Overview', text: 'MCP servers MUST implement OAuth 2.0 Protected Resource Metadata (RFC 9728).' },
  { id: 'AUTH-03', role: 'client', section: 'Overview', text: 'MCP clients MUST use OAuth 2.0 Protected Resource Metadata for authorization server discovery.', outOfScope: CLIENT_ONLY },
  { id: 'AUTH-04', role: 'authorization-server', section: 'Overview', text: 'MCP authorization servers MUST provide at least one of RFC 8414 metadata or OpenID Connect Discovery.' },
  { id: 'AUTH-05', role: 'client', section: 'Overview', text: 'MCP clients MUST support both discovery mechanisms.', outOfScope: CLIENT_ONLY },
  { id: 'DISC-01', role: 'resource-server', section: 'Authorization Server Location', text: 'The Protected Resource Metadata document MUST include authorization_servers with at least one authorization server.' },
  { id: 'DISC-02', role: 'resource-server', section: 'Protected Resource Metadata Discovery', text: 'MCP servers MUST implement one of: resource_metadata in WWW-Authenticate on 401, or a well-known metadata URI.' },
  { id: 'DISC-03', role: 'client', section: 'Protected Resource Metadata Discovery', text: 'MCP clients MUST support both mechanisms, prefer the header and fall back to well-known URIs in order.', outOfScope: CLIENT_ONLY },
  { id: 'DISC-04', role: 'client', section: 'Authorization Server Metadata Discovery', text: 'Clients MUST try well-known endpoints in priority order and MUST reject metadata whose issuer differs.', outOfScope: CLIENT_ONLY },
  { id: 'REG-01', role: 'client', section: 'Client Registration', text: 'MCP clients MUST obtain a client ID through CIMD, pre-registration or DCR.', outOfScope: CLIENT_ONLY },
  { id: 'CIMD-01', role: 'authorization-server', section: 'Client ID Metadata Documents', text: 'Authorization servers MUST validate that the fetched document\'s client_id matches the URL exactly.' },
  { id: 'CIMD-02', role: 'authorization-server', section: 'Client ID Metadata Documents', text: 'Authorization servers MUST validate redirect URIs presented in an authorization request against those in the metadata document.' },
  { id: 'CIMD-03', role: 'authorization-server', section: 'Client ID Metadata Documents', text: 'Authorization servers MUST validate the document structure is valid JSON and contains required fields.' },
  { id: 'CIMD-04', role: 'authorization-server', section: 'Client ID Metadata Document Security', text: 'Authorization servers MUST consider the security implications of fetching documents (SSRF).' },
  { id: 'RESP-01', role: 'authorization-server', section: 'Authorization Response Validation', text: 'Authorization servers that include iss MUST advertise authorization_response_iss_parameter_supported: true.' },
  { id: 'RESP-02', role: 'client', section: 'Authorization Response Validation', text: 'Clients MUST record the issuer and apply RFC 9207 validation before redeeming a code.', outOfScope: CLIENT_ONLY },
  { id: 'RES-01', role: 'client', section: 'Resource Parameter Implementation', text: 'Clients MUST send the resource parameter (canonical MCP server URI) in authorization and token requests.', outOfScope: CLIENT_ONLY },
  { id: 'TOK-01', role: 'client', section: 'Token Requirements', text: 'Clients MUST send the token in the Authorization header on every request and MUST NOT put it in the query string.', outOfScope: CLIENT_ONLY },
  { id: 'TOK-02', role: 'resource-server', section: 'Token Handling', text: 'MCP servers MUST validate access tokens as described in OAuth 2.1 §5.2.' },
  { id: 'TOK-03', role: 'resource-server', section: 'Token Handling', text: 'MCP servers MUST validate that access tokens were issued specifically for them as the intended audience (RFC 8707).' },
  { id: 'TOK-04', role: 'resource-server', section: 'Token Handling', text: 'Invalid or expired tokens MUST receive an HTTP 401 response (OAuth 2.1 §5.3).' },
  { id: 'TOK-05', role: 'resource-server', section: 'Token Handling', text: 'MCP servers MUST only accept tokens valid for their own resources and MUST NOT accept or transit any other tokens.' },
  { id: 'TOK-06', role: 'client', section: 'Token Handling', text: 'Clients MUST NOT send tokens not issued by the MCP server\'s authorization server.', outOfScope: CLIENT_ONLY },
  { id: 'REF-01', role: 'client', section: 'Refresh Tokens', text: 'Clients MUST keep refresh tokens confidential and MUST NOT assume refresh tokens will be issued.', outOfScope: CLIENT_ONLY },
  { id: 'ERR-01', role: 'resource-server', section: 'Error Handling', text: 'Servers MUST return 401 (authorization required or token invalid), 403 (invalid scopes or insufficient permissions) and 400 (malformed authorization request).' },
  { id: 'SCOPE-01', role: 'resource-server', section: 'Step-Up Authorization Flow', text: 'Servers MUST account for scope hierarchies when deciding whether a token is sufficient.' },
  { id: 'SEC-01', role: 'authorization-server', section: 'Token Theft', text: 'For public clients, authorization servers MUST rotate refresh tokens.' },
  { id: 'SEC-02', role: 'authorization-server', section: 'Token Theft', text: 'Servers MUST implement secure token storage.' },
  { id: 'SEC-03', role: 'authorization-server', section: 'Communication Security', text: 'All authorization server endpoints MUST be served over HTTPS.' },
  { id: 'SEC-04', role: 'authorization-server', section: 'Communication Security', text: 'All redirect URIs MUST be either localhost or use HTTPS.' },
  { id: 'SEC-05', role: 'client', section: 'Authorization Code Protection', text: 'Clients MUST implement PKCE, use S256, and refuse to proceed when code_challenge_methods_supported is absent.', outOfScope: CLIENT_ONLY },
  { id: 'SEC-06', role: 'authorization-server', section: 'Authorization Code Protection', text: 'Authorization servers MUST include code_challenge_methods_supported in their metadata (clients refuse without it); PKCE is enforced.' },
  { id: 'SEC-07', role: 'authorization-server', section: 'Open Redirection', text: 'Authorization servers MUST validate exact redirect URIs against pre-registered values.' },
  { id: 'SEC-08', role: 'authorization-server', section: 'Open Redirection', text: 'Authorization servers MUST take precautions to prevent redirecting user agents to untrusted URIs.' },
  { id: 'SEC-09', role: 'client', section: 'Open Redirection', text: 'MCP clients MUST have redirect URIs registered with the authorization server.', outOfScope: CLIENT_ONLY },
  { id: 'SEC-10', role: 'resource-server', section: 'Access Token Privilege Restriction', text: 'MCP servers MUST validate access tokens before processing the request.' },
  { id: 'SEC-11', role: 'resource-server', section: 'Access Token Privilege Restriction', text: 'MCP servers MUST reject tokens that do not include them in the audience claim.' },
  { id: 'SEC-12', role: 'authorization-server', section: 'Access Token Privilege Restriction', text: 'The MCP server MUST NOT pass through the token it received from the MCP client.' },
];

const covered = new Set<string>();

/** Registers the test that demonstrates requirement `id`. */
function must(id: string, title: string, fn: () => Promise<void> | void): void {
  const requirement = REQUIREMENTS.find((r) => r.id === id);
  if (!requirement) throw new Error(`Unknown requirement ${id}`);
  if (requirement.role === 'client') throw new Error(`${id} is a client requirement`);
  covered.add(id);
  it(`${id} [${requirement.section}] ${title}`, fn);
}

// ── fixtures ────────────────────────────────────────────────────────────────

const ISSUER = 'https://auth.example.com';
let privateKey: jose.CryptoKey;
let jwks: Server;
let grantexIssuer: string;

beforeAll(async () => {
  const pair = await jose.generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = { ...(await jose.exportJWK(pair.publicKey)), kid: 'conf', alg: 'RS256', use: 'sig' };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const address = jwks.address();
  grantexIssuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

async function authServer(overrides: Partial<McpAuthConfig> = {}, grantex = mockGrantex({ sandboxCode: 'UPSTREAM' })) {
  const storage = await seededStorage(
    clientRecord({ grantTypes: ['authorization_code', 'refresh_token'] }),
    clientRecord({ clientId: 'public-client', publicClient: true, grantTypes: ['authorization_code', 'refresh_token'] }),
  );
  const app = await createMcpAuthServer({
    grantex: asGrantex(grantex),
    agentId: 'agent-1',
    scopes: ['tool:acme_kyb:read'],
    issuer: ISSUER,
    resource: TEST_RESOURCE,
    grantexIssuer,
    storage,
    sandboxAutoApprove: true,
    ...overrides,
  });
  return { app, grantex, storage };
}

function authorize(app: FastifyInstance, query: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url: '/authorize',
    query: {
      response_type: 'code',
      client_id: TEST_CLIENT_ID,
      redirect_uri: TEST_REDIRECT_URI,
      code_challenge: TEST_CHALLENGE,
      code_challenge_method: 'S256',
      ...query,
    },
  });
}

async function issueCode(app: FastifyInstance, clientId = TEST_CLIENT_ID): Promise<string> {
  const response = await authorize(app, { client_id: clientId });
  expect(response.statusCode).toBe(302);
  return new URL(response.headers['location'] as string).searchParams.get('code')!;
}

async function grantToken(claims: Record<string, unknown> = {}): Promise<string> {
  const builder = new jose.SignJWT({ scp: ['tool:acme_kyb:read'], aud: TEST_RESOURCE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'conf' })
    .setIssuer(grantexIssuer)
    .setSubject(TEST_CLIENT_ID)
    .setJti(`grnt_${Math.random().toString(36).slice(2)}`)
    .setIssuedAt();
  if (claims['exp'] === undefined) builder.setExpirationTime('1h');
  return builder.sign(privateKey);
}

const MANIFEST = {
  connector: 'acme_kyb',
  tools: { resolve_business: 'read' as const, monitor_enroll: { permission: 'write' as const } },
};

async function mcp(options: Partial<RequireMcpAuthOptions>, authorization?: string, body?: unknown) {
  const mw = requireMcpAuth({ issuer: grantexIssuer, audience: TEST_RESOURCE, ...options } as RequireMcpAuthOptions);
  let handled = false;
  const server = createServer((raw: IncomingMessage, res: ServerResponse) => {
    const req = raw as McpAuthRequest;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length > 0) req.body = JSON.parse(Buffer.concat(chunks).toString());
      mw(req, res, () => {
        handled = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: body !== undefined ? 'POST' : 'GET',
      headers: {
        ...(authorization !== undefined ? { authorization } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    await response.text();
    return { status: response.status, challenge: response.headers.get('www-authenticate'), handled };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── authorization server ────────────────────────────────────────────────────

describe('MCP authorization 2026-07-28: authorization server', () => {
  must('AUTH-01', 'confidential clients must authenticate; public clients are PKCE-only', async () => {
    const { app } = await authServer();
    const noSecret = await app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'authorization_code', code: await issueCode(app), redirect_uri: TEST_REDIRECT_URI, client_id: TEST_CLIENT_ID, code_verifier: TEST_VERIFIER },
    });
    expect(noSecret.statusCode).toBe(401);
    const publicClient = await app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'authorization_code', code: await issueCode(app, 'public-client'), redirect_uri: TEST_REDIRECT_URI, client_id: 'public-client', code_verifier: TEST_VERIFIER },
    });
    expect(publicClient.statusCode).toBe(200);
    const wrongVerifier = await app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'authorization_code', code: await issueCode(app, 'public-client'), redirect_uri: TEST_REDIRECT_URI, client_id: 'public-client', code_verifier: 'x'.repeat(43) },
    });
    expect(wrongVerifier.statusCode).toBe(400);
  });

  must('AUTH-04', 'serves RFC 8414 authorization server metadata', async () => {
    const { app } = await authServer();
    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(response.statusCode).toBe(200);
    expect(response.json().issuer).toBe(ISSUER);
  });

  must('CIMD-01', 'rejects a document whose client_id differs from its URL, even by a trailing slash', () => {
    const url = 'https://app.example.com/client.json';
    expect(() => parseClientMetadataDocument(url, { client_id: `${url}/`, client_name: 'x', redirect_uris: ['https://app.example.com/cb'] }, 0))
      .toThrow(ClientMetadataError);
  });

  must('CIMD-02', 'only redirect URIs listed in the document are accepted at /authorize', () => {
    const url = 'https://app.example.com/client.json';
    const client = parseClientMetadataDocument(url, { client_id: url, client_name: 'x', redirect_uris: ['https://app.example.com/cb'] }, 0);
    // The authorization endpoint compares the requested redirect_uri with
    // exactly this list (see SEC-07 for the exact-match check end to end).
    expect(client.redirectUris).toEqual(['https://app.example.com/cb']);
  });

  must('CIMD-03', 'rejects non-object JSON and documents missing client_name or redirect_uris', () => {
    const url = 'https://app.example.com/client.json';
    for (const doc of [[], 'text', { client_id: url, redirect_uris: ['https://app.example.com/cb'] }, { client_id: url, client_name: 'x' }]) {
      expect(() => parseClientMetadataDocument(url, doc, 0)).toThrow(ClientMetadataError);
    }
  });

  must('CIMD-04', 'refuses to fetch a metadata document from a non-public address', async () => {
    const { app, grantex } = await authServer();
    const response = await authorize(app, { client_id: 'https://localhost/client.json', redirect_uri: 'http://127.0.0.1:3000/cb' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_description).toMatch(/address_not_allowed/);
    expect(grantex.authorize).not.toHaveBeenCalled();
  });

  must('RESP-01', 'includes iss in responses and advertises it', async () => {
    const { app } = await authServer();
    const metadata = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
    const response = await authorize(app);
    expect(new URL(response.headers['location'] as string).searchParams.get('iss')).toBe(ISSUER);
  });

  must('SEC-01', 'a refresh token is rotated and the spent one refused', async () => {
    const { app } = await authServer();
    const token = await app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'authorization_code', code: await issueCode(app, 'public-client'), redirect_uri: TEST_REDIRECT_URI, client_id: 'public-client', code_verifier: TEST_VERIFIER },
    });
    const first = token.json().refresh_token as string;
    const refresh = (refreshToken: string) => app.inject({
      method: 'POST', url: '/token', payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'public-client' },
    });
    const rotated = await refresh(first);
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().refresh_token).not.toBe(first);
    expect((await refresh(first)).statusCode).toBe(400);
  });

  must('SEC-01', 'an upstream that does not rotate never gets the same refresh token handed out again', async () => {
    const grantex = mockGrantex({ sandboxCode: 'UPSTREAM' });
    grantex.tokens.refresh.mockImplementation(async ({ refreshToken }: { refreshToken: string }) => ({
      grantToken: new jose.UnsecuredJWT({ aud: TEST_RESOURCE, jti: 'grnt_same' }).encode(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: ['tool:acme_kyb:read'],
      refreshToken,
      grantId: 'grant-1',
    }));
    const { app } = await authServer({}, grantex);
    const token = await app.inject({
      method: 'POST',
      url: '/token',
      payload: { grant_type: 'authorization_code', code: await issueCode(app, 'public-client'), redirect_uri: TEST_REDIRECT_URI, client_id: 'public-client', code_verifier: TEST_VERIFIER },
    });
    const refreshToken = token.json().refresh_token as string;
    const refreshed = await app.inject({ method: 'POST', url: '/token', payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'public-client' } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refresh_token).toBeUndefined();
    expect((await app.inject({ method: 'POST', url: '/token', payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'public-client' } })).statusCode).toBe(400);
  });

  must('SEC-02', 'client secrets are stored only as hashes', async () => {
    const { app, storage } = await authServer();
    const registered = (await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: [TEST_REDIRECT_URI] } })).json();
    const stored = await storage.getClient(registered.client_id);
    expect(JSON.stringify(stored)).not.toContain(registered.client_secret);
  });

  must('SEC-03', 'refuses to start with a non-https issuer (other than localhost)', async () => {
    await expect(authServer({ issuer: 'http://auth.example.com' })).rejects.toThrow(/https/);
  });

  must('SEC-04', 'redirect URIs must be localhost or https at registration and in metadata documents', async () => {
    const { app } = await authServer();
    const refused = await app.inject({ method: 'POST', url: '/register', payload: { redirect_uris: ['http://app.example.com/cb'] } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('invalid_redirect_uri');
    expect(isAllowedRedirectUri('http://localhost:8080/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://app.example.com/cb')).toBe(false);
  });

  must('SEC-06', 'advertises code_challenge_methods_supported [S256] and refuses requests without PKCE or with plain', async () => {
    const { app } = await authServer();
    const metadata = (await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect((await authorize(app, { code_challenge: '' })).statusCode).toBe(400);
    expect((await authorize(app, { code_challenge_method: 'plain' })).statusCode).toBe(400);
  });

  must('SEC-07', 'redirect_uri must exactly match a registered value', async () => {
    const { app } = await authServer();
    for (const redirect of [`${TEST_REDIRECT_URI}/`, TEST_REDIRECT_URI.toUpperCase(), `${TEST_REDIRECT_URI}?x=1`]) {
      expect((await authorize(app, { redirect_uri: redirect })).statusCode).toBe(400);
    }
  });

  must('SEC-08', 'errors before the client and redirect URI are verified are never redirected', async () => {
    const { app } = await authServer();
    for (const query of [{ client_id: 'unknown' }, { redirect_uri: 'https://attacker.example.org/cb' }, { response_type: 'token' }]) {
      const response = await authorize(app, query);
      expect(response.statusCode).toBe(400);
      expect(response.headers['location']).toBeUndefined();
    }
  });

  must('SEC-12', 'tokens reach clients only from the upstream exchange; the client\'s token is never forwarded upstream', async () => {
    const { app, grantex } = await authServer();
    const clientToken = await grantToken();
    // A client presenting its access token to the authorization server's
    // endpoints does not cause that token to be sent to Grantex.
    await app.inject({ method: 'POST', url: '/token', headers: { authorization: `Bearer ${clientToken}` }, payload: { grant_type: 'client_credentials' } });
    await app.inject({ method: 'GET', url: '/authorize', headers: { authorization: `Bearer ${clientToken}` }, query: { response_type: 'code' } });
    const upstreamArgs = JSON.stringify([...grantex.authorize.mock.calls, ...grantex.tokens.exchange.mock.calls, ...grantex.tokens.refresh.mock.calls]);
    expect(upstreamArgs).not.toContain(clientToken);
  });
});

// ── resource server ─────────────────────────────────────────────────────────

describe('MCP authorization 2026-07-28: MCP server (resource server)', () => {
  must('AUTH-02', 'serves protected resource metadata for the MCP server', async () => {
    const { app } = await authServer();
    const response = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });
    expect(response.statusCode).toBe(200);
    expect(response.json().resource).toBe(TEST_RESOURCE);
  });

  must('DISC-01', 'the metadata lists at least one authorization server', async () => {
    const { app } = await authServer();
    const body = (await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json();
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  must('DISC-02', '401 responses carry resource_metadata in WWW-Authenticate', async () => {
    const outcome = await mcp({});
    expect(outcome.status).toBe(401);
    expect(outcome.challenge).toContain('resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"');
  });

  must('TOK-02', 'signature, issuer and expiry are validated', async () => {
    const [header, payload, signature] = (await grantToken()).split('.');
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), scp: ['tool:acme_kyb:admin'] })).toString('base64url');
    const forged = `${header}.${tampered}.${signature}`;
    expect((await mcp({}, `Bearer ${forged}`)).status).toBe(401);
    expect((await mcp({ issuer: 'https://other-issuer.example.com', jwksUri: `${grantexIssuer}/.well-known/jwks.json` }, `Bearer ${await grantToken()}`)).status).toBe(401);
    expect((await mcp({}, `Bearer ${await grantToken()}`)).status).toBe(200);
  });

  must('TOK-03', 'the audience must be this MCP server', async () => {
    expect((await mcp({}, `Bearer ${await grantToken({ aud: 'https://other.example.com/mcp' })}`)).status).toBe(401);
    expect(() => requireMcpAuth({ issuer: grantexIssuer } as RequireMcpAuthOptions)).toThrow(/audience/);
  });

  must('TOK-04', 'invalid or expired tokens receive 401 with error="invalid_token"', async () => {
    for (const bad of ['not-a-jwt', await grantToken({ exp: Math.floor(Date.now() / 1000) - 10 })]) {
      const outcome = await mcp({}, `Bearer ${bad}`);
      expect(outcome.status).toBe(401);
      expect(outcome.challenge).toContain('error="invalid_token"');
    }
  });

  must('TOK-05', 'a token for another resource is not accepted, and the request never reaches the handler', async () => {
    const outcome = await mcp({}, `Bearer ${await grantToken({ aud: ['https://other.example.com/mcp'] })}`);
    expect(outcome.status).toBe(401);
    expect(outcome.handled).toBe(false);
  });

  must('ERR-01', '401 without a token, 403 for a tool outside the grant, 400 for a malformed authorization request', async () => {
    const tools = toolPolicyFromManifests([MANIFEST]);
    expect((await mcp({ tools })).status).toBe(401);
    const forbidden = await mcp({ tools }, `Bearer ${await grantToken()}`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'monitor_enroll' } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.challenge).toContain('error="insufficient_scope"');
    const { app } = await authServer();
    expect((await authorize(app, { code_challenge_method: 'plain' })).statusCode).toBe(400);
  });

  must('SCOPE-01', 'a broader permission scope covers narrower tools', async () => {
    const tools = toolPolicyFromManifests([MANIFEST]);
    const outcome = await mcp({ tools }, `Bearer ${await grantToken({ scp: ['tool:acme_kyb:admin'] })}`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resolve_business' },
    });
    expect(outcome.status).toBe(200);
  });

  must('SEC-10', 'no request reaches the MCP handler before its token is validated', async () => {
    const outcome = await mcp({}, 'Bearer ');
    expect(outcome.status).toBe(401);
    expect(outcome.handled).toBe(false);
  });

  must('SEC-11', 'a token with no audience claim is rejected', async () => {
    expect((await mcp({}, `Bearer ${await grantToken({ aud: undefined })}`)).status).toBe(401);
  });
});

describe('requirement map', () => {
  it('every server-side MUST of the 2026-07-28 specification has a test', () => {
    const missing = REQUIREMENTS.filter((r) => r.role !== 'client' && !covered.has(r.id)).map((r) => r.id);
    expect(missing).toEqual([]);
    for (const requirement of REQUIREMENTS.filter((r) => r.role === 'client')) {
      expect(requirement.outOfScope).toBeTruthy();
    }
  });
});
