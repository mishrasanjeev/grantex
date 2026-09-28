import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

assert.ok(process.argv[2], 'Pass a clean installed package directory');
const root = resolve(process.argv[2]);
const load = (name, entry = 'index.js') => import(pathToFileURL(resolve(root, 'node_modules', name, 'dist', entry)).href);
const mcp = await load('@grantex/mcp-auth');
const { InMemoryStorage } = await load('@grantex/mcp-auth', 'testing.js');
const { Grantex } = await load('@grantex/sdk');
assert.equal(JSON.parse(readFileSync(resolve(root, 'node_modules/@grantex/mcp-auth/package.json'), 'utf8')).version, '4.0.0');
assert.match(readFileSync(resolve(root, 'node_modules/@grantex/mcp-auth/CHANGELOG.md'), 'utf8'), /4\.0\.0/);

let subject = 'prn_artifact';
let active = true;
let outage = false;
const calls = [];
const unsigned = () => [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: subject, aud: 'https://mcp.example.com/mcp', jti: 'grnt_artifact', scp: ['read'] })).toString('base64url'), ''].join('.');
const upstream = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    calls.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/authorize') {
      res.end(JSON.stringify({ authRequestId: 'areq_artifact', principalId: 'prn_artifact', consentUrl: 'https://grantex.example.com/consent', expiresAt: new Date(Date.now() + 600000).toISOString() }));
    } else if (req.url === '/v1/grants/verify') {
      res.statusCode = outage ? 503 : 200;
      res.end(JSON.stringify(outage ? { message: 'unavailable' } : active ? { active: true, claims: { sub: subject, aud: 'https://mcp.example.com/mcp', jti: 'grnt_artifact', agt: 'did:grantex:ag_artifact', dev: 'dev_artifact', grnt: 'grnt_artifact', scp: ['read'], exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) } } : { active: false, reason: 'revoked' }));
    } else if (req.url === '/v1/token' || req.url === '/v1/token/refresh') {
      res.end(JSON.stringify({ grantToken: unsigned(), expiresAt: new Date(Date.now() + 3600000).toISOString(), refreshToken: req.url.endsWith('refresh') ? 'rt_second' : 'rt_first', grantId: 'grnt_artifact', scopes: ['read'] }));
    } else if (req.url?.startsWith('/v1/tokens/') || req.url === '/v1/token/revoke') {
      res.statusCode = 204; res.end();
    } else { res.statusCode = 404; res.end('{}'); }
  });
});
await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
let app;
try {
  const grantex = new Grantex({ apiKey: 'artifact-test-only', baseUrl: `http://127.0.0.1:${upstream.address().port}`, maxRetries: 0 });
  const storage = new InMemoryStorage();
  await storage.putClient({ clientId: 'client_artifact', redirectUris: ['https://app.example.com/callback'], tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], createdAt: new Date().toISOString() });
  let human = 'tenant-a:human-artifact';
  app = await mcp.createMcpAuthServer({ grantex, agentId: 'ag_artifact', issuer: 'https://auth.example.com', resource: 'https://mcp.example.com/mcp', scopes: ['read'], storage, resolvePrincipal: async () => human ? { principalId: human } : undefined });
  const verifier = 'a'.repeat(43);
  const query = { response_type: 'code', client_id: 'client_artifact', redirect_uri: 'https://app.example.com/callback', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'read' };
  const page = await app.inject({ method: 'GET', url: '/authorize', query });
  assert.equal(page.statusCode, 200);
  assert.equal(calls.length, 0, 'no upstream authorization before a human approves');
  const consentId = /name="consent_id" value="([^"]+)"/.exec(page.body)[1];
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(page.body)[1];
  const cookie = String(page.headers['set-cookie']).split(';')[0];
  const approved = await app.inject({ method: 'POST', url: '/consent', headers: { cookie, origin: 'https://auth.example.com', 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ consent_id: consentId, csrf_token: csrf, decision: 'approve' }).toString() });
  assert.equal(approved.statusCode, 303);
  const authorization = calls.find((c) => c.path === '/v1/authorize');
  assert.equal(authorization.body.principalId, human, 'real SDK sends human ID, not OAuth client ID');
  const cookies = [].concat(approved.headers['set-cookie']).map((c) => c.split(';')[0]);
  const callbackCookie = cookies.find((c) => /mcp_auth_callback_/.test(c));
  const callback = await app.inject({ method: 'GET', url: '/callback', query: { state: authorization.body.state, code: 'upstream_code' }, headers: { cookie: callbackCookie } });
  assert.equal(callback.statusCode, 302);
  const code = new URL(callback.headers.location).searchParams.get('code');
  const token = await app.inject({ method: 'POST', url: '/token', payload: { grant_type: 'authorization_code', code, redirect_uri: query.redirect_uri, client_id: query.client_id, code_verifier: verifier } });
  assert.equal(token.statusCode, 200, token.body);
  const refresh = await app.inject({ method: 'POST', url: '/token', payload: { grant_type: 'refresh_token', refresh_token: token.json().refresh_token, client_id: query.client_id } });
  assert.equal(refresh.statusCode, 200, refresh.body);
  const current = mcp.grantexCurrentGrantVerifier(grantex);
  assert.equal(await current.verify(unsigned()), true);
  active = false;
  assert.equal(await current.verify(unsigned()), false);
  outage = true;
  await assert.rejects(current.verify(unsigned()));
  human = undefined;
  assert.equal((await app.inject({ method: 'GET', url: '/authorize', query })).statusCode, 401);
  console.log('MCP Auth 4 packed/registry artifact: rendered human consent, real SDK principal handoff, callback, exchange, refresh, online authority and outage checks passed');
} finally {
  await app?.close();
  await new Promise((done) => upstream.close(done));
}
