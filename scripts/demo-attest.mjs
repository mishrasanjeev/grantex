#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Demo 1: developer opt-in attestation, end to end, against the mock
// accredited issuer. No external party, no network beyond loopback.
//
//   register agent -> prove key -> request attestation -> level attested ->
//   lookup shows it -> issuer revokes -> level drops and lookup shows revoked
//
// Every step prints `live` (the registry, a real auth-service process on a
// local port backed by the Postgres in DATABASE_URL) or `fixture` (the mock
// issuer, packages/mock-issuer). The script exits non-zero at the first step
// whose outcome is not the expected one.
//
// Needs: Postgres (DATABASE_URL) and Redis (REDIS_URL), Node 24+, a Python
// with the SDK installed from packages/sdk-py (DEMO_PYTHON, default python3
// then python), apps/auth-service built (npm run build), packages/agent-passport
// built and packages/mock-issuer installed (make install). `make demo-attest`.

import { RegistryDemo, TRUST_MARKS, expect, findPython, http, runDemo, summarizeAttestations } from './lib/registry-demo.mjs';

const REVOCATION_TIMEOUT_MS = 30_000;
const LOOKUP_SETTLE_MS = 15_000;

await runDemo('demo-attest', async () => {
  const demo = new RegistryDemo('demo-attest');
  try {
<<<<<<< HEAD
    const python = findPython();
    await demo.start();
    await demo.signup();
    await demo.registerProvider();
    await demo.registerAgent();
    demo.generateAgentKey(python);

    // ── the attestation step: one command ──────────────────────────────────
    demo.runGrantexAttest(python);
=======
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const runUrl = new URL(url);
  runUrl.pathname = `/${name}`;
  return {
    url: runUrl.toString(),
    name,
    async drop() {
      const again = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await again.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await again.end();
      }
    },
  };
}

/** The Python that has the SDK: DEMO_PYTHON, else python3, else python. */
function findPython() {
  const candidates = process.env.DEMO_PYTHON ? [process.env.DEMO_PYTHON] : ['python3', 'python'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import grantex.cli.attest, grantex.issuers'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  fail(`no Python with the SDK installed (tried ${candidates.join(', ')}); pip install -e packages/sdk-py`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Start a child, resolve with its first stdout line, keep it for cleanup. */
function startAndReadLine(command, args, options, label) {
  return new Promise((resolveLine, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const newline = out.indexOf('\n');
      if (newline !== -1) resolveLine(out.slice(0, newline));
    });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('exit', (code) => {
      if (out.indexOf('\n') === -1) reject(new Error(`${label} exited ${code} before its first line: ${err.trim()}`));
    });
    child.on('error', reject);
  });
}

async function http(method, url, { body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    init.headers['Content-Type'] = raw ? headers['Content-Type'] : 'application/json';
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, json, text };
}

async function waitForHealth(baseUrl, authService) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let stderr = '';
  authService.stderr?.on('data', (chunk) => { stderr += chunk; });
  while (Date.now() < deadline) {
    if (authService.exitCode !== null) fail(`the auth service exited ${authService.exitCode}:\n${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`the auth service did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s:\n${stderr}`);
}

/** GET the lookup every 500 ms until `done(json)` or the deadline; the last answer either way. */
async function pollLookup(url, done, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let polls = 0;
  let last = null;
  for (;;) {
    polls += 1;
    last = await http('GET', url);
    expect(last.status === 200, `public lookup answered ${last.status}: ${last.text}`);
    if (done(last.json) || Date.now() >= deadline) return { ...last, polls };
    await new Promise((r) => setTimeout(r, 500));
  }
}


/**
 * Verify a JWS the registry signed (ES256 or RS256, kid in its JWK Set) and
 * return its payload: typ, iss, sub and exp are checked, so a malformed,
 * foreign, stale or re-signed status list fails the demo rather than passing
 * it. Uses node:crypto only.
 */
async function verifyRegistryJws(token, { jwksUrl, typ, iss, sub }) {
  const { createPublicKey, verify } = await import('node:crypto');
  const [h, p, s] = token.split('.');
  expect(h && p && s, 'the registry answered something that is not a compact JWS');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  expect(header.typ === typ, `JWS typ is ${header.typ}, expected ${typ}`);
  const jwks = await (await fetch(jwksUrl)).json();
  const jwk = (jwks.keys ?? []).find((k) => k.kid === header.kid);
  expect(jwk, `the registry's JWK Set has no key ${header.kid}`);
  const algorithms = { ES256: ['sha256', { dsaEncoding: 'ieee-p1363' }], RS256: ['sha256', {}] };
  const [hash, extra] = algorithms[header.alg] ?? [];
  expect(hash, `unsupported JWS alg ${header.alg}`);
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = verify(hash, Buffer.from(`${h}.${p}`), { key, ...extra }, Buffer.from(s, 'base64url'));
  expect(ok, 'the status list signature does not verify against the registry JWK Set');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  expect(payload.iss === iss, `status list iss is ${payload.iss}, expected ${iss}`);
  expect(payload.sub === sub, `status list sub is ${payload.sub}, expected ${sub}`);
  const now = Math.floor(Date.now() / 1000);
  expect(typeof payload.exp === 'number' && payload.exp > now, 'the status list has expired');
  return payload;
}

/** The registry's acceptance entry for an attestation: its Token Status List verified, read and decoded. */
async function acceptanceStatus(codec, entry, registry) {
  const response = await fetch(entry.uri, { headers: { Accept: 'application/statuslist+jwt' } });
  expect(response.ok, `acceptance list ${entry.uri} answered ${response.status}`);
  const token = (await response.text()).trim();
  const payload = await verifyRegistryJws(token, {
    jwksUrl: `${registry}/.well-known/jwks.json`, typ: 'statuslist+jwt', iss: registry, sub: entry.uri,
  });
  const list = codec.decodeTokenStatusList(payload.status_list);
  const value = list.statusAt(entry.idx);
  const name = Object.entries(codec.TOKEN_STATUS).find(([, v]) => v === value)?.[0] ?? String(value);
  return { value, name };
}

function summarizeAttestations(lookup) {
  const attestations = Array.isArray(lookup.attestations) ? lookup.attestations : [];
  // The public lookup lists counted attestations only: type, issuer, expiry.
  return attestations.map((a) => {
    const type = String(a.type ?? '').replace('urn:grantex:tm:', '');
    return `${type} (${String(a.issuer ?? '?').replace('https://', '')}, exp ${String(a.expires_at ?? '?').slice(0, 10)})`;
  }).join(', ') || 'none';
}

async function main() {
  expect(existsSync(MOCK_ISSUER_CLI), `missing ${MOCK_ISSUER_CLI}`);
  expect(existsSync(AUTH_SERVICE), `missing ${AUTH_SERVICE}; build it with: cd apps/auth-service && npm run build`);
  const python = findPython();
  const state = mkdtempSync(join(tmpdir(), 'grantex-demo-attest-'));
  const mockArgs = (...args) => [MOCK_ISSUER_CLI, ...args, '--dir', state];
  let database = null;

  try {
    if (FRESH_DATABASE) {
      database = await createRunDatabase(DATABASE_URL);
      step('database created for this run', 'live', database.name);
    }

    // ── the mock accredited issuer ──────────────────────────────────────────
    const serveLine = await startAndReadLine('node', mockArgs('serve', '--ttl', String(STATUS_TTL_SECONDS)), { cwd: REPO }, 'mock issuer');
    const serve = JSON.parse(serveLine);
    step('mock issuer serving JWKS and status lists', 'fixture', `${serve.origin} ttl=${serve.ttl}s`);
    const keys = JSON.parse(run('node', mockArgs('keys'), { cwd: REPO }));
    step('mock issuer keys read', 'fixture', `${keys.entity_id} kid=${keys.kid}`);

    // ── the registry: a real auth service on a local port ──────────────────
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const operatorKey = randomBytes(24).toString('hex');
    const authEnv = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: database ? database.url : DATABASE_URL,
      REDIS_URL,
      DATABASE_POOL_MAX: '3',
      AUTO_GENERATE_KEYS: 'true',
      JWT_ISSUER: baseUrl,
      PUBLIC_BASE_URL: baseUrl,
      ADMIN_API_KEY: randomBytes(24).toString('hex'),
      METRICS_API_KEY: randomBytes(24).toString('hex'),
      VAULT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      REGISTRY_OPERATOR_API_KEYS: operatorKey,
      REGISTRY_DEV_ISSUER_ORIGIN_MAP: serve.origin_map,
      REGISTRY_STATUS_RECONCILIATION_ENABLED: 'true',
      REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '1000',
      REGISTRY_PUBLIC_ENDPOINTS_ENABLED: 'true',
      LOG_LEVEL: process.env.DEMO_LOG_LEVEL ?? 'warn',
      LOG_PRETTY: 'false',
    };
    delete authEnv.SEED_API_KEY;
    delete authEnv.SEED_SANDBOX_KEY;
    const authService = spawn('node', [AUTH_SERVICE], { cwd: join(REPO, 'apps', 'auth-service'), env: authEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(authService);
    await waitForHealth(baseUrl, authService);
    step('registry (auth service) healthy', 'live', `${baseUrl} migrations applied at startup`);

    // ── accredit the mock issuer (platform operator) ────────────────────────
    const accredited = await http('POST', `${baseUrl}/v1/registry/issuers`, {
      headers: { Authorization: `Bearer ${operatorKey}` },
      body: {
        entity_id: keys.entity_id,
        jwks: keys.jwks,
        trust_marks: TRUST_MARKS,
        status_list_base: keys.status_list_base,
        accreditation_evidence_ref: 'demo:mock-issuer:accreditation',
      },
    });
    expect(accredited.status === 201, `accreditation answered ${accredited.status}: ${accredited.text}`);
    step('mock issuer accredited for agent.identity, provider.entity', 'live', `issuer ${accredited.json.id} status=${accredited.json.status}`);

    // ── a developer, its provider, its agent ───────────────────────────────
    const signup = await http('POST', `${baseUrl}/v1/signup`, { body: { name: 'Demo Developer', mode: 'live' } });
    expect(signup.status === 201 || signup.status === 200, `signup answered ${signup.status}: ${signup.text}`);
    const apiKey = signup.json.apiKey;
    const auth = { Authorization: `Bearer ${apiKey}` };
    step('developer signed up', 'live', signup.json.developerId);

    const org = await http('POST', `${baseUrl}/v1/registry/orgs`, { headers: auth, body: { did: PROVIDER_DID, name: 'Provider Example' } });
    expect(org.status === 201 || org.status === 200, `provider registration answered ${org.status}: ${org.text}`);
    step('provider registered (the agent\'s developer)', 'live', `${PROVIDER_DID} trust_level=${org.json.trustLevel ?? org.json.trust_level ?? '?'}`);

    const agent = await http('POST', `${baseUrl}/v1/agents`, {
      headers: auth,
      body: { name: 'Nimbus Shopper 2.4', description: 'shopper-01', scopes: ['calendar:read'] },
    });
    expect(agent.status === 201 || agent.status === 200, `agent registration answered ${agent.status}: ${agent.text}`);
    const agentId = agent.json.id ?? agent.json.agentId;
    const agentDid = agent.json.did;
    step('agent registered', 'live', `${agentId} ${agentDid}`);

    // ── the agent's key: generated locally, where the mock issuer can find it ─
    const generated = JSON.parse(run(python, ['-c',
      'import json; from grantex.issuers import generate_agent_key as g; p, _, t = g(); print(json.dumps({"thumbprint": t, "private": p}))']));
    mkdirSync(join(state, 'agents'), { recursive: true });
    const keyFile = join(state, 'agents', `${generated.thumbprint}.json`);
    writeFileSync(keyFile, `${JSON.stringify(generated.private)}\n`, { mode: 0o600 });
    step('agent key generated (ES256, P-256)', 'local', `thumbprint ${generated.thumbprint}`);

    // ── the attestation step: one command ──────────────────────────────────
    const attest = spawnSync(python, ['-m', 'grantex.cli.attest', agentId, '--key', keyFile, '--provider-did', PROVIDER_DID], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        GRANTEX_API_KEY: apiKey,
        GRANTEX_BASE_URL: baseUrl,
        GRANTEX_ISSUER_ADAPTER: 'mock',
        GRANTEX_MOCK_ISSUER_DIR: state,
      },
    });
    const attestSteps = attest.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let attestationId = null;
    for (const s of attestSteps) {
      const source = s.source === 'live' ? 'live' : s.source === 'mock' ? 'fixture' : s.source;
      const { step: name, source: _source, ...rest } = s;
      step(`grantex-attest: ${name}`, source, Object.entries(rest).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' '));
      if (name === 'attestation_issued' && attestationId === null) attestationId = s.issuer_attestation_id;
    }
    expect(attest.status === 0, `grantex-attest exited ${attest.status}: ${attest.stderr.trim()}`);
    const lookupStep = attestSteps.find((s) => s.step === 'lookup');
    expect(lookupStep?.level === 'attested', `expected level attested after attestation, got ${lookupStep?.level}`);
    expect(attestationId !== null, 'grantex-attest printed no attestation id');
>>>>>>> feat/demo-attest

    // ── the public lookup shows it ─────────────────────────────────────────
    const lookupUrl = `${demo.baseUrl}/v1/registry/agents/${encodeURIComponent(demo.agent.did)}`;
    const shown = await demo.pollLookup(lookupUrl, (json) => json.level === 'attested', LOOKUP_SETTLE_MS);
    expect(shown.json.level === 'attested', `public lookup shows level ${shown.json.level}, expected attested: ${shown.text}`);
    demo.step('public lookup (no API key) shows the level', 'live', `level=${shown.json.level} attestations: ${summarizeAttestations(shown.json)} (${shown.polls} polls)`);

    // ── a relying party reads the status list entries behind the level ─────
    const relying = await http('GET', lookupUrl, { headers: demo.auth });
    expect(relying.status === 200, `relying-party lookup answered ${relying.status}: ${relying.text}`);
    const identity = (relying.json.attestations ?? []).find((a) => a.type === TRUST_MARKS[0]);
    expect(identity?.acceptance_status_list?.uri, `relying-party lookup carries no acceptance list entry: ${relying.text}`);
<<<<<<< HEAD
    const before = await demo.acceptanceStatus(identity.acceptance_status_list);
    expect(before.isValid, `acceptance entry reads ${before.name} before revocation`);
    demo.step('relying-party lookup (API key): acceptance entry', 'live', `${identity.acceptance_status_list.uri} idx=${identity.acceptance_status_list.idx} ${before.name}`);
=======
    const codec = await import(pathToFileURL(STATUS_LIST_CODEC).href);
    const before = await acceptanceStatus(codec, identity.acceptance_status_list, baseUrl);
    expect(before.value === codec.TOKEN_STATUS.VALID, `acceptance entry reads ${before.name} before revocation`);
    step('relying-party lookup (API key): acceptance entry', 'live', `${identity.acceptance_status_list.uri} idx=${identity.acceptance_status_list.idx} ${before.name}`);
>>>>>>> feat/demo-attest

    // ── the issuer revokes; the registry notices through the status list ───
    demo.revokeAtIssuer();
    const after = await demo.pollLookup(lookupUrl, (json) => json.level !== 'attested', REVOCATION_TIMEOUT_MS);
    expect(after.json.level !== 'attested', `level is still attested ${REVOCATION_TIMEOUT_MS / 1000}s after revocation: ${after.text}`);
    demo.step('level dropped; revoked attestations no longer listed', 'live', `level=${after.json.level} attestations: ${summarizeAttestations(after.json)} (${after.polls} polls)`);

    // The registry's own word on it: the acceptance entry is INVALID.
    const deadline = Date.now() + REVOCATION_TIMEOUT_MS;
<<<<<<< HEAD
    let acceptance = await demo.acceptanceStatus(identity.acceptance_status_list);
    while (!acceptance.isInvalid && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      acceptance = await demo.acceptanceStatus(identity.acceptance_status_list);
=======
    let acceptance = await acceptanceStatus(codec, identity.acceptance_status_list, baseUrl);
    while (acceptance.value !== codec.TOKEN_STATUS.INVALID && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      acceptance = await acceptanceStatus(codec, identity.acceptance_status_list, baseUrl);
>>>>>>> feat/demo-attest
    }
    expect(acceptance.isInvalid, `acceptance entry reads ${acceptance.name} after revocation`);
    demo.step('acceptance list shows the attestation revoked', 'live', `idx=${identity.acceptance_status_list.idx} ${acceptance.name}`);
  } finally {
    await demo.finish();
  }
});
