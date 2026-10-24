import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '.');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-example-key', alg: 'ES256', use: 'sig' };
const calls = [];
const audit = [];
let base;

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const grant = { agent_did: 'did:grantex:shopper-01', developer_id: 'synthetic-developer', grant_id: 'synthetic-grant' };
  const payload = {
    iss: base, sub: 'test-user-001', jti: 'synthetic-token', iat: now, exp: now + 300,
    scope: 'calendar:read email:send', scp: ['calendar:read', 'email:send'],
    agt: grant.agent_did, dev: grant.developer_id, grnt: grant.grant_id, 'urn:grantex:grant': grant,
  };
  const input = [{ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid }, payload]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, base).pathname;
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const data = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};
    calls.push(`${request.method} ${path}`);
    let result;
    if (path === '/.well-known/jwks.json') result = { keys: [jwk] };
    else if (path === '/v1/agents' && request.method === 'POST') result = { ...data, id: 'synthetic-agent', agentId: 'synthetic-agent', did: 'did:grantex:shopper-01' };
    else if (path === '/v1/authorize') result = { authRequestId: 'synthetic-auth', principalId: 'test-user-001', code: 'synthetic-code', consentUrl: `${base}/consent`, expiresAt: new Date(Date.now() + 300000).toISOString() };
    else if (path === '/v1/token') result = { grantToken: jwt(), grantId: 'synthetic-grant', refreshToken: 'synthetic-refresh', expiresIn: 300 };
    else if (path === '/v1/audit/log') {
      assert.equal(data.agentDid, 'did:grantex:shopper-01');
      assert.equal(data.principalId, 'test-user-001');
      const entry = { ...data, entryId: `synthetic-entry-${audit.length}`, timestamp: new Date().toISOString() };
      audit.push(entry);
      result = entry;
    } else if (path === '/v1/audit/entries') result = { entries: audit, total: audit.length };
    else { response.statusCode = 404; result = { error: 'unexpected_synthetic_route' }; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
base = `http://127.0.0.1:${server.address().port}`;
try {
  const env = { ...process.env, GRANTEX_URL: base, GRANTEX_ISSUER: base, GRANTEX_API_KEY: 'synthetic-key', LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' };
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY']) delete env[name];
  const child = spawn(process.execPath, [resolve(directory, 'node_modules/tsx/dist/cli.mjs'), resolve(directory, 'src/index.ts')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', value => { output += value; process.stdout.write(value); });
  child.stderr.on('data', value => { output += value; process.stderr.write(value); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  const code = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, 'The local example must complete');
  assert.match(output, /Done!/);
  assert.doesNotMatch(output, /ERROR: should have thrown|Scope enforcement did not refuse/);
  assert(calls.includes('GET /.well-known/jwks.json'), 'The example must verify against the loopback issuer');
  assert(audit.filter(entry => entry.status === 'success').length >= 2, 'Both fake tools must produce audit evidence');
  console.log(JSON.stringify({ localOnly: true, paidModelCalls: false, calls, auditEntries: audit.length }));
} finally {
  await new Promise(resolve => server.close(resolve));
}
