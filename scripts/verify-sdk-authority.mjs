import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const consumer = process.env.GRANTEX_AUTHORITY_CONSUMER_DIR;
const requireSdk = createRequire(consumer ? resolve(consumer, 'package.json') : new URL('../packages/sdk-ts/package.json', import.meta.url));
async function loadPackage(directory, name) {
  if (!consumer) return import(`../packages/${directory}/dist/index.js`);
  const root = resolve(consumer, 'node_modules', '@grantex', name);
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return import(pathToFileURL(resolve(root, manifest.exports['.'].import)).href);
}
const { SignJWT, exportJWK, generateKeyPair, decodeJwt } = await import(pathToFileURL(requireSdk.resolve('jose')).href);
const { Grantex } = await loadPackage('sdk-ts', 'sdk');
const pair = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(pair.publicKey), kid: 'audit-key', alg: 'RS256', use: 'sig' };
let mode = 'active';
let authorityCalls = 0;
let upstreamCalls = 0;
const issuer = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/.well-known/jwks.json') return response.end(JSON.stringify({ keys: [jwk] }));
  if (request.url !== '/v1/grants/verify') { response.statusCode = 404; return response.end('{}'); }
  authorityCalls++;
  assert.equal(request.headers.authorization, 'Bearer synthetic-audit-key');
  let body = '';
  for await (const chunk of request) body += chunk;
  const claims = decodeJwt(JSON.parse(body).token);
  if (mode === 'outage') { response.statusCode = 503; return response.end('{}'); }
  if (mode === 'revoked') return response.end(JSON.stringify({ active: false }));
  if (mode === 'malformed') return response.end(JSON.stringify({ active: 'false', claims }));
  if (mode === 'principal') claims.sub = 'different-human';
  if (mode === 'agent') claims['urn:grantex:grant'].agent_did = 'did:grantex:different';
  if (mode === 'tenant') claims['urn:grantex:grant'].developer_id = 'different-tenant';
  if (mode === 'token') claims.jti = 'different-token';
  if (mode === 'issuer') claims.iss = 'https://different-issuer.example';
  if (mode === 'audience') claims.aud = 'different-service';
  response.end(JSON.stringify({ active: true, claims }));
});
issuer.listen(0, '127.0.0.1');
await once(issuer, 'listening');
const baseUrl = `http://127.0.0.1:${issuer.address().port}`;
const upstream = createServer((_request, response) => { upstreamCalls++; response.end('ok'); });
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const client = new Grantex({ apiKey: 'synthetic-audit-key', baseUrl, maxRetries: 0 });
async function sign(overrides = {}) {
  return new SignJWT({ scope: 'calendar:read', 'urn:grantex:grant': {
    grant_id: 'grant-audit', agent_did: 'did:grantex:agent-audit', developer_id: 'tenant-audit',
  }, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'audit-key', typ: 'at+jwt' })
    .setIssuer(baseUrl).setSubject('human-audit').setJti('token-audit').setIssuedAt().setExpirationTime('1h').setAudience('calendar-service').sign(pair.privateKey);
}
const token = await sign();
const common = {
  name: 'calendar_read', description: 'Synthetic calendar read', grantToken: token,
  requiredScope: 'calendar:read', jwksUri: `${baseUrl}/.well-known/jwks.json`,
  audience: 'calendar-service', expectedPrincipalId: 'human-audit', expectedAgentDid: 'did:grantex:agent-audit',
  currentAuthority: (input) => client.grants.verify(input),
};
const jsonSchema = { type: 'object', properties: {} };
const factories = [];
for (const name of ['anthropic', 'autogen', 'langchain', 'vercel-ai', 'strands', 'a2a', 'express', 'adapters', 'gateway']) {
  const module = await loadPackage(name, name);
  factories.push([name, async (options, execute) => {
    if (name === 'anthropic') { const tool = module.createGrantexTool({ ...options, inputSchema: jsonSchema, execute }); return () => tool.execute({}); }
    if (name === 'autogen') { const tool = module.createGrantexFunction({ ...options, parameters: jsonSchema, func: execute }); return () => tool.execute({}); }
    if (name === 'langchain') { const tool = module.createGrantexTool({ ...options, func: execute }); return () => tool.invoke('synthetic'); }
    if (name === 'vercel-ai' || name === 'strands') {
      const req = createRequire(new URL(`../packages/${name}/package.json`, import.meta.url));
      const { z } = await import(pathToFileURL(req.resolve('zod')).href);
      const tool = module.createGrantexTool({ ...options, parameters: z.object({}), inputSchema: z.object({}), execute, callback: execute });
      return name === 'strands' ? () => tool.invoke({}) : () => tool.execute({}, { toolCallId: 'audit', messages: [] });
    }
    if (name === 'a2a') {
      const middleware = module.createA2AAuthMiddleware({ ...options, requiredScopes: ['calendar:read'] });
      return async () => { await middleware({ headers: { authorization: `Bearer ${options.grantToken}` } }); return execute(); };
    }
    if (name === 'express') {
      const middleware = module.requireGrantToken(options);
      return () => new Promise((resolve, reject) => {
        const response = { status() { return this; }, json(body) { reject(new Error(body.message)); } };
        middleware({ headers: { authorization: `Bearer ${options.grantToken}` } }, response, (err) => err ? reject(err) : resolve(execute()));
      });
    }
    if (name === 'adapters') {
      class ProbeAdapter extends module.BaseAdapter { async run() { await this.verifyAndCheckScope(options.grantToken, 'calendar:read'); await this.resolveCredential(); return execute(); } }
      const adapter = new ProbeAdapter({ ...options, credentials: () => { execute(); return 'synthetic-upstream-key'; } });
      return () => adapter.run();
    }
    const app = module.createGatewayServer({ ...options, upstream: upstreamUrl, port: 0,
      routes: [{ path: '/calendar', methods: ['GET'], requiredScopes: ['calendar:read'] }] });
    const call = async () => {
      const response = await app.inject({ method: 'GET', url: '/calendar', headers: { authorization: `Bearer ${options.grantToken}` } });
      assert.equal(response.statusCode, 200);
      return execute();
    };
    call.close = () => app.close();
    return call;
  }]);
}
let checks = 0;
try {
  for (const [name, factory] of factories) {
    mode = 'active';
    let executions = 0;
    const invoke = await factory(common, async () => { executions++; return 'ok'; });
    await invoke();
    assert.ok(executions > 0, `${name}: authorized callback missing`);
    const initialExecutions = executions;
    const initialUpstream = upstreamCalls;
    const initialAuthority = authorityCalls;
    checks++;
    for (mode of ['revoked', 'outage', 'malformed', 'principal', 'agent', 'tenant', 'token', 'issuer', 'audience']) {
      await assert.rejects(invoke, undefined, `${name}: ${mode} must be denied`);
      assert.equal(executions, initialExecutions, `${name}: denied call executed`);
      assert.equal(upstreamCalls, initialUpstream, `${name}: denied call proxied`);
      checks++;
    }
    assert.equal(authorityCalls - initialAuthority, 9, `${name}: current authority must be checked each time`);
    if (invoke.close) await invoke.close();
    mode = 'active';
    const wrongHuman = await factory({ ...common, expectedPrincipalId: 'another-human' }, async () => { throw new Error('callback reached'); });
    const beforeWrongHuman = authorityCalls;
    await assert.rejects(wrongHuman);
    assert.equal(authorityCalls, beforeWrongHuman, `${name}: wrong human reached authority`);
    if (wrongHuman.close) await wrongHuman.close();
    checks++;
    console.log(`PASS ${name}: active, revoked, outage, malformed authority, human/agent/tenant/token substitution, trusted host identity`);
  }
  const gateway = await import('../packages/gateway/dist/index.js');
  const yamlConfig = gateway.validateConfig({ upstream: upstreamUrl, jwksUri: common.jwksUri,
    audience: common.audience, currentAuthorityCheck: true, grantexBaseUrl: baseUrl,
    grantexApiKey: 'synthetic-audit-key', expectedPrincipalId: common.expectedPrincipalId,
    expectedAgentDid: common.expectedAgentDid,
    routes: [{ path: '/calendar', methods: ['GET'], requiredScopes: ['calendar:read'] }] });
  const app = gateway.createGatewayServer(yamlConfig);
  try {
    mode = 'active';
    const response = await app.inject({ method: 'GET', url: '/calendar', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    checks++;
    const before = upstreamCalls;
    mode = 'revoked';
    const denied = await app.inject({ method: 'GET', url: '/calendar', headers: { authorization: `Bearer ${token}` } });
    assert.equal(denied.statusCode, 401);
    assert.equal(upstreamCalls, before);
    checks++;
  } finally { await app.close(); }
  console.log(`PASS ${checks} real-JWKS / HTTP authority execution-boundary checks`);
} finally {
  issuer.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise((resolve) => issuer.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
}
