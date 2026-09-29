import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.argv[2], 'Pass a clean consumer directory');
const root = resolve(process.argv[2]);
const require = createRequire(resolve(root, 'package.json'));
const load = async (name) => {
  if (!name.startsWith('@grantex/')) return import(pathToFileURL(require.resolve(name)).href);
  const [scope, packageName, ...subpath] = name.split('/');
  const directory = resolve(root, 'node_modules', scope, packageName);
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  const entry = manifest.exports[subpath.length ? `./${subpath.join('/')}` : '.'];
  assert.ok(entry?.import, `${name} ESM export`);
  return import(pathToFileURL(resolve(directory, entry.import)).href);
};
const versions = new Map([
  ['@grantex/sdk', '0.8.1'], ['@grantex/cli', '0.4.1'],
  ['@grantex/gateway', '0.2.1'], ['@grantex/adapters', '0.2.1'],
  ['@grantex/strands', '0.2.1'], ['@grantex/mcp-auth', '4.0.0'],
]);
for (const [name, version] of versions) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'node_modules', name, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version, name);
  assert.equal(manifest.engines.node, '>=22.12.0', `${name} runtime`);
  assert.match(readFileSync(resolve(root, 'node_modules', name, 'LICENSE'), 'utf8'), /Apache License/);
  assert.match(readFileSync(resolve(root, 'node_modules', name, 'NOTICE'), 'utf8'), /Orchestrum Technologies LLP/);
  assert.ok(readFileSync(resolve(root, 'node_modules', name, 'README.md'), 'utf8').includes('migration-enforcement'), `${name} migration documentation`);
}
assert.doesNotMatch(
  readFileSync(resolve(root, 'node_modules/@grantex/sdk/README.md'), 'utf8'),
  /console\.log\((?:token|delegation)\.(?:grantToken|refreshToken)\)/,
  'SDK documentation must not log bearer credentials',
);
const sdk = await load('@grantex/sdk');
const jose = await load('jose');
assert.equal(sdk.DEFAULT_REVOCATION_CHECK, 'online');
assert.equal(sdk.REVOCATION_CHECK_STRENGTH.online, 2);
for (const name of ['@grantex/gateway', '@grantex/adapters', '@grantex/strands', '@grantex/mcp-auth']) await load(name);
for (const subpath of ['postgres', 'redis', 'testing', 'express', 'hono']) await load(`@grantex/mcp-auth/${subpath}`);
const mcp = await load('@grantex/mcp-auth');
assert.throws(() => mcp.createMcpResourceGuard({ issuer: 'https://issuer.example', audience: 'https://merchant.example' }), /revocations/);
assert.throws(() => mcp.createMcpResourceGuard({ issuer: 'https://issuer.example', audience: 'https://merchant.example', revocations: { isTokenRevoked: async () => false } }), /currentGrant/);

const key = await jose.generateKeyPair('RS256', { extractable: true });
const publicJwk = { ...await jose.exportJWK(key.publicKey), kid: 'release-key', alg: 'RS256', use: 'sig' };
let revoked = false;
let statusUnavailable = false;
let statusCalls = 0;
let userAgent;
let upstreamCalls = 0;
let issuerRevoked = false;
let issuerUnavailable = false;
let issuerCalls = 0;
const server = createServer((req, res) => {
  if (req.url === '/v1/grants/verify') {
    issuerCalls++;
    assert.equal(req.headers.authorization, 'Bearer artifact-test-only');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const input = JSON.parse(body);
      res.writeHead(issuerUnavailable ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(issuerUnavailable ? { message: 'test unavailable' } : issuerRevoked ? { active: false, reason: 'revoked' } : { active: true, claims: jose.decodeJwt(input.token) }));
    });
    return;
  }
  if (req.url.startsWith('/upstream/')) {
    upstreamCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/.well-known/jwks.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (req.url.startsWith('/v1/revocations/status?')) {
    statusCalls++;
    userAgent = req.headers['user-agent'];
    assert.equal(req.headers.authorization, 'Bearer artifact-test-only');
    res.writeHead(statusUnavailable ? 503 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(statusUnavailable ? { message: 'test unavailable' } : { status: revoked ? 'revoked' : 'active', revoked }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
try {
  const issuer = `http://127.0.0.1:${server.address().port}`;
  const audience = 'https://api.merchant.example';
  const client = new sdk.Grantex({ apiKey: 'artifact-test-only', baseUrl: issuer, issuer, audience, maxRetries: 0 });
  client.loadManifest(new sdk.ToolManifest({ connector: 'payments', tools: { pay: 'write' } }));
  const token = await new jose.SignJWT({
    scope: 'tool:payments:write:*:capped:100',
    'urn:grantex:grant': { agent_did: 'did:grantex:ag_release', developer_id: 'dev_release', grant_id: 'grnt_release', delegation_depth: 0 },
  }).setProtectedHeader({ alg: 'RS256', kid: 'release-key', typ: 'at+jwt' })
    .setIssuer(issuer).setAudience(audience).setSubject('principal_release')
    .setJti('tok_release').setIssuedAt().setExpirationTime('5m').sign(key.privateKey);
  const call = { grantToken: token, connector: 'payments', tool: 'pay' };
  const verified = await sdk.verifyGrantToken(token, {
    jwksUri: `${issuer}/.well-known/jwks.json`, issuer, audience,
  });
  assert.equal(verified.tokenId, 'tok_release', 'Audience-bound README verification flow');
  const allowed = await client.enforce({ ...call, amount: 10 });
  assert.equal(allowed.allowed, true, JSON.stringify(allowed));
  assert.equal(statusCalls, 1, 'Default must query current status');
  assert.equal(userAgent, '@grantex/sdk/0.8.0');
  const missing = await client.enforce(call);
  assert.equal(missing.allowed, false);
  assert.equal(missing.subReason, 'amount_missing');
  assert.equal((await client.enforce({ ...call, amount: 101 })).allowed, false);
  const wrongAudience = await client.enforce({ ...call, amount: 10, audience: 'https://other.example' });
  assert.equal(wrongAudience.allowed, false);
  assert.equal(wrongAudience.subReason, 'audience_mismatch');
  const unconfigured = new sdk.Grantex({ apiKey: 'artifact-test-only', baseUrl: issuer, issuer });
  unconfigured.loadManifest(new sdk.ToolManifest({ connector: 'payments', tools: { pay: 'write' } }));
  assert.equal((await unconfigured.enforce({ ...call, amount: 10 })).subReason, 'audience_unconfigured');
  await assert.rejects(client.enforce({ ...call, amount: 10, revocationCheck: 'offline' }), /cannot loosen/);
  let executions = 0;
  const wrapped = client.wrapTool({ name: 'pay', description: 'Synthetic payment', invoke: async () => ++executions }, {
    grantToken: token, connector: 'payments', tool: 'pay', extractAmount: (input) => input.amount,
  });
  assert.equal(await wrapped.invoke({ amount: 10 }), 1);
  await assert.rejects(wrapped.invoke({}), /amount/i);
  assert.equal(executions, 1, 'Missing amount must prevent side effects');
  const strands = await load('@grantex/strands');
  const { z } = await load('zod');
  let strandExecutions = 0;
  const strandTool = strands.createGrantexTool({
    name: 'pay', description: 'Synthetic payment', inputSchema: z.object({}),
    grantToken: token, requiredScope: 'tool:payments:write', online: true,
    client, connector: 'payments', amount: 10, audience,
    callback: () => ++strandExecutions,
  });
  assert.equal(await strandTool.invoke({}), 1, 'Real installed Strands tool invocation');
  const wrongStrand = strands.createGrantexTool({
    name: 'pay', description: 'Synthetic payment', inputSchema: z.object({}),
    grantToken: token, requiredScope: 'tool:payments:write', online: true,
    client, connector: 'payments', amount: 10, audience: 'https://other.example',
    callback: () => ++strandExecutions,
  });
  await assert.rejects(wrongStrand.invoke({}));
  assert.equal(strandExecutions, 1);
  const adapters = await load('@grantex/adapters');
  class ProbeAdapter extends adapters.BaseAdapter {
    async probe(value) { return this.verifyAndCheckScope(value, 'tool:payments:write'); }
  }
  const badAdapter = new ProbeAdapter({ jwksUri: `${issuer}/.well-known/jwks.json`, credentials: 'synthetic', audience: 'https://other.example' });
  await assert.rejects(badAdapter.probe(token), (err) => err.code === 'AUDIENCE_MISMATCH');
  const noAudienceAdapter = new ProbeAdapter({ jwksUri: `${issuer}/.well-known/jwks.json`, credentials: 'synthetic' });
  await assert.rejects(noAudienceAdapter.probe(token), (err) => err.code === 'AUDIENCE_UNCONFIGURED');
  const gateway = await load('@grantex/gateway');
  const gatewayServer = gateway.createGatewayServer({
    upstream: `${issuer}/upstream`, jwksUri: `${issuer}/.well-known/jwks.json`,
    audience: 'https://other.example', port: 0,
    routes: [{ path: '/probe', methods: ['GET'], requiredScopes: [] }],
  });
  try {
    const response = await gatewayServer.inject({ method: 'GET', url: '/probe', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error, 'AUDIENCE_MISMATCH');
    assert.equal(upstreamCalls, 0);
  } finally { await gatewayServer.close(); }
  const guard = mcp.createMcpResourceGuard({ issuer, audience, jwksUri: `${issuer}/.well-known/jwks.json`, revocations: { isTokenRevoked: async () => revoked }, currentGrant: mcp.grantexCurrentGrantVerifier(client) });
  const guardedRequest = { method: 'GET', header: (name) => name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined };
  assert.equal((await guard(guardedRequest)).ok, true);
  assert.equal(issuerCalls, 1, 'Installed MCP verifier calls the issuer');
  assert.equal((await guard(guardedRequest)).ok, true);
  assert.equal(issuerCalls, 2, 'MCP verifier must not positively cache active authority');
  issuerRevoked = true;
  const issuerDenial = await guard(guardedRequest);
  assert.equal(issuerDenial.ok, false);
  assert.equal(issuerDenial.status, 401, 'Issuer revocation denies even when local revocation has not synchronized');
  issuerRevoked = false;
  issuerUnavailable = true;
  const issuerOutage = await guard(guardedRequest);
  assert.equal(issuerOutage.ok, false);
  assert.equal(issuerOutage.status, 503, 'Issuer outage fails closed');
  issuerUnavailable = false;
  revoked = true;
  const denial = await client.enforce({ ...call, amount: 10 });
  assert.equal(denial.allowed, false);
  assert.equal(denial.reasonCode, 'grant_revoked');
  await assert.rejects(strandTool.invoke({}));
  assert.equal(strandExecutions, 1);
  assert.equal((await guard(guardedRequest)).ok, false, 'Packaged MCP guard rejects recorded revocation');
  statusUnavailable = true;
  const unavailable = await client.enforce({ ...call, amount: 10 });
  assert.equal(unavailable.allowed, false);
  assert.equal(unavailable.subReason, 'status_unavailable');
  console.log('Enforcement artifact verification passed: exact versions, imports, audience, amount, side-effect prevention, default revocation, current issuer authority, outage refusal and real installed integration guards.');
} finally {
  await new Promise((done) => server.close(done));
}
