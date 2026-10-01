// SPDX-License-Identifier: Apache-2.0
//
// What the registry demos share: the mock accredited issuer on loopback, a
// real auth service on a local port with a database of its own, the mock
// accredited, a developer with a provider and an agent, the agent's key, and
// the attestation step (grantex-attest). Every step is labelled `live` (the
// registry) or `fixture` (the mock issuer).
//
// The registry advertises REGISTRY_ORIGIN (https) as its public origin and
// issuer while listening on loopback over http; `fetchMapped` rewrites that
// origin, and the mock issuer's, to their loopback servers, exactly as the
// auth service's REGISTRY_DEV_ISSUER_ORIGIN_MAP does for the mock's lists.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MOCK_ISSUER_CLI = join(REPO, 'packages', 'mock-issuer', 'src', 'cli.ts');
export const AUTH_SERVICE = join(REPO, 'apps', 'auth-service', 'dist', 'index.js');
export const STATUS_LIST_CODEC = join(REPO, 'apps', 'auth-service', 'dist', 'lib', 'registry', 'status-list-codec.js');
export const REGISTRY_ORIGIN = 'https://registry.example';
export const MOCK_ISSUER_ORIGIN = 'https://mock-issuer.example';
export const PROVIDER_DID = 'did:web:provider.example';
export const TRUST_MARKS = ['urn:grantex:tm:agent.identity', 'urn:grantex:tm:provider.entity'];
export const HEALTH_TIMEOUT_MS = 90_000;
// The mock's status list ttl. The registry relies on a read of the list until
// its ttl runs out and reads it again one reconciliation tick before that, so
// a ttl of a few seconds keeps the level steady between reads and still shows
// a revocation within seconds. (1 s, the mock's default, is for CI tests that
// read the list themselves; see FINDINGS G-143.)
export const STATUS_TTL_SECONDS = Number(process.env.DEMO_STATUS_TTL_SECONDS ?? 5);

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://grantex:grantex@127.0.0.1:5432/grantex';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
// Each run gets a database of its own, created from DATABASE_URL and dropped
// at the end, so the run is repeatable (the mock issuer is accredited once per
// registry). DEMO_FRESH_DATABASE=0 runs against DATABASE_URL itself.
export const FRESH_DATABASE = process.env.DEMO_FRESH_DATABASE !== '0';

export function fail(message) {
  throw new Error(message);
}

export function expect(condition, message) {
  if (!condition) fail(message);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

/** A database for this run only, created beside the one in DATABASE_URL. */
async function createRunDatabase(url, prefix) {
  const postgres = createRequire(join(REPO, 'apps', 'auth-service', 'package.json'))('postgres');
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  try {
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

/** The Python that has the packages: DEMO_PYTHON, else python3, else python. */
export function findPython(probe = 'import grantex.cli.attest, grantex.issuers') {
  const candidates = process.env.DEMO_PYTHON ? [process.env.DEMO_PYTHON] : ['python3', 'python'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', probe], { encoding: 'utf8' });
    if (result.status === 0) return candidate;
  }
  fail(`no Python with the needed packages (tried ${candidates.join(', ')}; probe: ${probe})`);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Start a child, resolve with its first stdout line. */
function startAndReadLine(children, command, args, options, label) {
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

export async function http(method, url, { body, headers = {}, raw = false } = {}) {
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

/** An SD-JWT presentation: compact JWS segments and disclosures, base64url only. */
export const SD_JWT_PRESENTATION = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(~[A-Za-z0-9_-]*)*~?$/;
/** A compact JWS (RFC 7515 section 7.1). */
export const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function summarizeAttestations(lookup) {
  const attestations = Array.isArray(lookup.attestations) ? lookup.attestations : [];
  // The public lookup lists counted attestations only: type, issuer, expiry.
  return attestations.map((a) => {
    const type = String(a.type ?? '').replace('urn:grantex:tm:', '');
    return `${type} (${String(a.issuer ?? '?').replace('https://', '')}, exp ${String(a.expires_at ?? '?').slice(0, 10)})`;
  }).join(', ') || 'none';
}

export class RegistryDemo {
  constructor(name) {
    this.name = name;
    this.stepNumber = 0;
    this.children = [];
    this.state = mkdtempSync(join(tmpdir(), `grantex-${name}-`));
    this.database = null;
    this.codec = null;
  }

  step(title, source, detail) {
    this.stepNumber += 1;
    const line = `[${String(this.stepNumber).padStart(2, '0')}] ${title.padEnd(52)} ${source.padEnd(7)} ${detail ?? ''}`;
    process.stdout.write(`${line.trimEnd()}\n`);
  }

  mockArgs(...args) {
    return [MOCK_ISSUER_CLI, ...args, '--dir', this.state];
  }

  /** The URL to fetch for one the registry or the mock issuer advertises. */
  mapUrl(url) {
    const parsed = new URL(url);
    const rest = parsed.pathname + parsed.search;
    if (parsed.origin === REGISTRY_ORIGIN) return this.baseUrl + rest;
    if (parsed.origin === MOCK_ISSUER_ORIGIN) return this.serve.origin + rest;
    return url;
  }

  /** Mock issuer, database, auth service; then the mock accredited. */
  async start({ registryEnv = {} } = {}) {
    expect(existsSync(MOCK_ISSUER_CLI), `missing ${MOCK_ISSUER_CLI}`);
    expect(existsSync(AUTH_SERVICE), `missing ${AUTH_SERVICE}; build it with: cd apps/auth-service && npm run build`);
    if (FRESH_DATABASE) {
      this.database = await createRunDatabase(DATABASE_URL, this.name.replace(/-/g, '_'));
      this.step('database created for this run', 'live', this.database.name);
    }

    const serveLine = await startAndReadLine(
      this.children, 'node', this.mockArgs('serve', '--ttl', String(STATUS_TTL_SECONDS)), { cwd: REPO }, 'mock issuer');
    this.serve = JSON.parse(serveLine);
    this.step('mock issuer serving JWKS and status lists', 'fixture', `${this.serve.origin} ttl=${this.serve.ttl}s`);
    this.keys = JSON.parse(run('node', this.mockArgs('keys'), { cwd: REPO }));
    this.step('mock issuer keys read', 'fixture', `${this.keys.entity_id} kid=${this.keys.kid}`);

    const port = await freePort();
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.operatorKey = randomBytes(24).toString('hex');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      HOST: '127.0.0.1',
      DATABASE_URL: this.database ? this.database.url : DATABASE_URL,
      REDIS_URL,
      DATABASE_POOL_MAX: '3',
      AUTO_GENERATE_KEYS: 'true',
      // The registry's public identity: an https origin, mapped to loopback by the demos.
      JWT_ISSUER: REGISTRY_ORIGIN,
      PUBLIC_BASE_URL: REGISTRY_ORIGIN,
      ADMIN_API_KEY: randomBytes(24).toString('hex'),
      METRICS_API_KEY: randomBytes(24).toString('hex'),
      VAULT_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      REGISTRY_OPERATOR_API_KEYS: this.operatorKey,
      REGISTRY_DEV_ISSUER_ORIGIN_MAP: this.serve.origin_map,
      REGISTRY_STATUS_RECONCILIATION_ENABLED: 'true',
      REGISTRY_STATUS_POLL_MIN_INTERVAL_MS: '1000',
      REGISTRY_PUBLIC_ENDPOINTS_ENABLED: 'true',
      PASSPORT_BOUND_GRANTS_ENABLED: 'true',
      LOG_LEVEL: process.env.DEMO_LOG_LEVEL ?? 'warn',
      LOG_PRETTY: 'false',
      ...registryEnv,
    };
    delete env.SEED_API_KEY;
    delete env.SEED_SANDBOX_KEY;
    const authService = spawn('node', [AUTH_SERVICE], { cwd: join(REPO, 'apps', 'auth-service'), env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.children.push(authService);
    await this.waitForHealth(authService);
    this.step('registry (auth service) healthy', 'live', `${this.baseUrl} as ${REGISTRY_ORIGIN}; migrations applied at startup`);

    const accredited = await http('POST', `${this.baseUrl}/v1/registry/issuers`, {
      headers: { Authorization: `Bearer ${this.operatorKey}` },
      body: {
        entity_id: this.keys.entity_id,
        jwks: this.keys.jwks,
        trust_marks: TRUST_MARKS,
        status_list_base: this.keys.status_list_base,
        accreditation_evidence_ref: 'demo:mock-issuer:accreditation',
      },
    });
    expect(accredited.status === 201, `accreditation answered ${accredited.status}: ${accredited.text}`);
    this.step('mock issuer accredited for agent.identity, provider.entity', 'live', `issuer ${accredited.json.id} status=${accredited.json.status}`);
    return this;
  }

  async waitForHealth(authService) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let stderr = '';
    authService.stderr?.on('data', (chunk) => { stderr += chunk; });
    while (Date.now() < deadline) {
      if (authService.exitCode !== null) fail(`the auth service exited ${authService.exitCode}:\n${stderr}`);
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (response.ok) return;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    fail(`the auth service did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s:\n${stderr}`);
  }

  /** A developer; `sandbox` mode lets a script approve its own authorization requests. */
  async signup(mode = 'sandbox') {
    const signup = await http('POST', `${this.baseUrl}/v1/signup`, { body: { name: 'Demo Developer', mode } });
    expect(signup.status === 201 || signup.status === 200, `signup answered ${signup.status}: ${signup.text}`);
    this.apiKey = signup.json.apiKey;
    this.auth = { Authorization: `Bearer ${this.apiKey}` };
    this.step(`developer signed up (${mode})`, 'live', signup.json.developerId);
    return signup.json;
  }

  async registerProvider() {
    const org = await http('POST', `${this.baseUrl}/v1/registry/orgs`, { headers: this.auth, body: { did: PROVIDER_DID, name: 'Provider Example' } });
    expect(org.status === 201 || org.status === 200, `provider registration answered ${org.status}: ${org.text}`);
    this.step('provider registered (the agent\'s developer)', 'live', `${PROVIDER_DID} trust_level=${org.json.trustLevel ?? org.json.trust_level ?? '?'}`);
    return org.json;
  }

  async registerAgent(extra = {}) {
    const agent = await http('POST', `${this.baseUrl}/v1/agents`, {
      headers: this.auth,
      body: { name: 'Nimbus Shopper 2.4', description: 'shopper-01', scopes: ['read'], ...extra },
    });
    expect(agent.status === 201 || agent.status === 200, `agent registration answered ${agent.status}: ${agent.text}`);
    this.agent = { id: agent.json.id ?? agent.json.agentId, did: agent.json.did };
    this.step('agent registered', 'live', `${this.agent.id} ${this.agent.did}`);
    return this.agent;
  }

  /** The agent's key, generated by the SDK and placed where the mock issuer runs the possession proof. */
  generateAgentKey(python) {
    const generated = JSON.parse(run(python, ['-c',
      'import json; from grantex.issuers import generate_agent_key as g; p, _, t = g(); print(json.dumps({"thumbprint": t, "private": p}))']));
    mkdirSync(join(this.state, 'agents'), { recursive: true });
    const keyFile = join(this.state, 'agents', `${generated.thumbprint}.json`);
    writeFileSync(keyFile, `${JSON.stringify(generated.private)}\n`, { mode: 0o600 });
    this.agentKey = { thumbprint: generated.thumbprint, file: keyFile };
    this.step('agent key generated (ES256, P-256)', 'local', `thumbprint ${generated.thumbprint}`);
    return this.agentKey;
  }

  /** grantex-attest: register and prove the key, attest through the mock adapter, ingest, look up. */
  runGrantexAttest(python, extraArgs = []) {
    const attest = spawnSync(python, ['-m', 'grantex.cli.attest', this.agent.id, '--key', this.agentKey.file, '--provider-did', PROVIDER_DID, ...extraArgs], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, GRANTEX_API_KEY: this.apiKey, GRANTEX_BASE_URL: this.baseUrl, GRANTEX_ISSUER_ADAPTER: 'mock', GRANTEX_MOCK_ISSUER_DIR: this.state },
    });
    const steps = attest.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    let attestationId = null;
    for (const s of steps) {
      const source = s.source === 'live' ? 'live' : s.source === 'mock' ? 'fixture' : s.source;
      const { step: name, source: _source, ...rest } = s;
      this.step(`grantex-attest: ${name}`, source, Object.entries(rest).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`).join(' '));
      if (name === 'attestation_issued' && attestationId === null) attestationId = s.issuer_attestation_id;
    }
    expect(attest.status === 0, `grantex-attest exited ${attest.status}: ${attest.stderr.trim()}`);
    const lookup = steps.find((s) => s.step === 'lookup');
    expect(lookup?.level === 'attested', `expected level attested after attestation, got ${lookup?.level}`);
    expect(attestationId !== null, 'grantex-attest printed no attestation id');
    this.attestationId = attestationId;
    return { steps, attestationId };
  }

  /** GET the lookup every 500 ms until `done(json)` or the deadline; the last answer either way. */
  async pollLookup(url, done, timeoutMs, headers = {}) {
    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    let last = null;
    for (;;) {
      polls += 1;
      last = await http('GET', url, { headers });
      expect(last.status === 200, `lookup answered ${last.status}: ${last.text}`);
      if (done(last.json) || Date.now() >= deadline) return { ...last, polls };
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** The registry's acceptance entry for an attestation: its Token Status List read and decoded. */
  async acceptanceStatus(entry) {
    if (this.codec === null) this.codec = await import(pathToFileURL(STATUS_LIST_CODEC).href);
    const response = await fetch(this.mapUrl(entry.uri), { headers: { Accept: 'application/statuslist+jwt' } });
    expect(response.ok, `acceptance list ${entry.uri} answered ${response.status}`);
    const token = (await response.text()).trim();
    // Signed by the registry: verified against its JWK Set before anything is read from it.
    const payload = await verifyRegistryJws(token, {
      jwksUrl: `${this.baseUrl}/.well-known/jwks.json`, typ: 'statuslist+jwt', iss: REGISTRY_ORIGIN, sub: entry.uri,
    });
    const list = this.codec.decodeTokenStatusList(payload.status_list);
    const value = list.statusAt(entry.idx);
    const name = Object.entries(this.codec.TOKEN_STATUS).find(([, v]) => v === value)?.[0] ?? String(value);
    return { value, name, isValid: value === this.codec.TOKEN_STATUS.VALID, isInvalid: value === this.codec.TOKEN_STATUS.INVALID };
  }

  /** Revoke the passport at the issuer. */
  revokeAtIssuer() {
    const revoked = JSON.parse(run('node', this.mockArgs('revoke', '--attestation-id', this.attestationId), { cwd: REPO }));
    this.step('issuer revokes the passport', 'fixture', `${this.attestationId} status=${revoked.status}`);
    return revoked;
  }

  /** Stop the children, drop the database, remove the state directory. */
  async finish() {
    for (const child of this.children) {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(this.children.map((child) => new Promise((done) => {
      if (child.exitCode !== null) return done();
      child.once('exit', done);
      setTimeout(done, 5_000).unref();
    })));
    if (this.database) {
      await this.database.drop().catch((error) => process.stderr.write(`${this.name}: could not drop ${this.database.name}: ${error.message}\n`));
    }
    rmSync(this.state, { recursive: true, force: true });
  }
}

/** Run a demo's main with the shared reporting and exit handling. */
export async function runDemo(name, main) {
  try {
    await main();
    process.stdout.write(`\n${name}: PASS\n`);
  } catch (error) {
    process.stderr.write(`\n${name}: FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
