/**
 * The oacp suite against an in-memory stand-in for the auth service, with the
 * real SDK verifier (packages/sdk-ts/src/oacp). Keys are generated per run.
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createOacpSuite, type OacpVerifierModule } from '../src/suites/oacp.js';
import type { ConformanceHttpClient } from '../src/http-client.js';
import type { HttpResponse, SuiteContext, TestResult } from '../src/types.js';
import { canonicalize } from '../../sdk-ts/src/canonical.js';
import * as sdk from '../../sdk-ts/src/oacp/index.js';

const BASE = 'https://issuer.example';
const NOW = new Date('2026-10-19T11:00:00.000Z');
const b64u = (value: string | Buffer) => Buffer.from(value).toString('base64url');

type Json = Record<string, unknown>;

interface ServerOptions {
  /** Sign artifacts with the pre-OACP template instead of a JWS. */
  templateSignature?: boolean;
  /** Sign artifacts with a key the JWKS does not publish. */
  foreignKey?: boolean;
  /** Revoke without flipping the status list entry. */
  revokeWithoutStatus?: boolean;
}

function fakeAuthService(options: ServerOptions = {}) {
  const artifactKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const foreign = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const listKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'oacp-conformance-test';
  const jwks = {
    keys: [
      { ...artifactKey.publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' },
      { ...listKey.publicKey.export({ format: 'jwk' }), kid: 'platform-test', alg: 'RS256', use: 'sig' },
    ],
  };
  const listId = 'lst_CONFTEST';
  const listUri = `${BASE}/status/oacp/${listId}`;
  const statuses = new Map<number, number>();
  const rows = new Map<string, { envelope: Json; payload: Json; status: string; revoked_at: string | null }>();
  const tokens: string[] = [];
  let nextIdx = 3;

  const signEnvelope = (envelope: Json): string => {
    if (options.templateSignature) return `${b64u('{"alg":"ES256"}')}..sig_${String(envelope['artifact_id'])}`;
    const header = b64u(JSON.stringify({ alg: 'ES256', kid, typ: 'oacp-artifact+jws' }));
    const input = `${header}.${b64u(canonicalize(envelope))}`;
    const key = options.foreignKey ? foreign.privateKey : artifactKey.privateKey;
    return `${header}..${b64u(sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }))}`;
  };

  const issue = (family: string, type: string, scope: Json, extra: Json): { artifact_family: string; artifact_type: string; envelope: Json; payload: Json } => {
    const artifactId = `oacp_art_${family}_${String(scope['merchant_id'])}`;
    const payload: Json = { artifact_family: family, ...scope, allowed_to_execute: false, ...extra };
    const idx = nextIdx++;
    const envelope: Json = {
      artifact_id: artifactId,
      artifact_type: type,
      schema_version: 'oacp.artifact.v1',
      issuer: BASE,
      issuer_key_id: kid,
      subject_type: type,
      subject_id: `${String(scope['merchant_id'])}:${String(scope['seller_agent_id'])}`,
      ...scope,
      buyer_agent_id: '',
      issued_at: new Date(NOW.getTime() - 1000).toISOString(),
      expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
      freshness_class: 'fresh',
      revocation_status_url: listUri,
      status: { status_list: { idx, uri: listUri } },
      policy_version: 'oacp-policy-test',
      evidence_refs: ['conformance:evidence:redacted'],
      payload_hash: createHash('sha256').update(canonicalize(payload)).digest('hex'),
      signature_alg: 'ES256',
      safety: { public_safe: true, contains_private_data: false },
    };
    const signed = { ...envelope, signature: signEnvelope(envelope) };
    rows.set(artifactId, { envelope: signed, payload, status: 'issued', revoked_at: null });
    statuses.set(idx, 0);
    return { artifact_family: family, artifact_type: type, envelope: signed, payload };
  };

  const statusListToken = (): string => {
    const bytes = Buffer.alloc(16);
    for (const [idx, status] of statuses) bytes[idx >> 2]! |= status << ((idx & 3) * 2);
    const header = b64u(JSON.stringify({ alg: 'RS256', kid: 'platform-test', typ: 'statuslist+jwt' }));
    const iat = Math.floor(NOW.getTime() / 1000) - 30;
    const claims = b64u(JSON.stringify({ iss: BASE, sub: listUri, iat, exp: iat + 3600, ttl: 600, status_list: { bits: 2, lst: deflateSync(bytes).toString('base64url') } }));
    return `${header}.${claims}.${b64u(sign('sha256', Buffer.from(`${header}.${claims}`), listKey.privateKey))}`;
  };

  const reply = <T>(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse<T> => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: body as T,
    rawText: typeof body === 'string' ? body : JSON.stringify(body),
    durationMs: 0,
  });

  const route = (method: string, path: string, body: unknown): HttpResponse<unknown> => {
    const [pathname, search = ''] = path.split('?');
    if (method === 'POST' && pathname === '/v1/commerce/oacp/c6z/authority-requests') {
      const request = (body as { request: Json }).request;
      const scope = { tenant_id: request['tenant_id'], merchant_id: request['merchant_id'], seller_agent_id: request['seller_agent_id'] };
      const artifacts = [
        issue('catalog_snapshot', 'catalog_snapshot', scope, { product_count: 2 }),
        issue('protocol_adapter', 'protocol_adapter', scope, { adapter_surfaces: ['schema_org_product_offer_jsonld'] }),
      ];
      return reply(201, { status: 'artifact_issuance_ready', artifacts });
    }
    if (method === 'GET' && pathname === '/v1/commerce/oacp/artifacts') {
      const query = new URLSearchParams(search);
      const items = [...rows.values()].filter((row) => row.envelope['merchant_id'] === query.get('merchant_id'));
      return reply(200, { items: items.map((row) => ({ artifact_id: row.envelope['artifact_id'], envelope: row.envelope })) });
    }
    const match = /^\/v1\/commerce\/oacp\/artifacts\/([^/]+)(\/revoke)?$/.exec(pathname ?? '');
    if (match) {
      const row = rows.get(decodeURIComponent(match[1]!));
      if (!row) return reply(404, { code: 'not_found' });
      if (method === 'POST' && match[2]) {
        row.status = 'revoked';
        row.revoked_at = NOW.toISOString();
        if (!options.revokeWithoutStatus) {
          const ref = (row.envelope['status'] as { status_list: { idx: number } }).status_list;
          statuses.set(ref.idx, 1);
        }
        const scope = { tenant_id: row.envelope['tenant_id'], merchant_id: row.envelope['merchant_id'], seller_agent_id: row.envelope['seller_agent_id'] };
        const revocation = issue('revocation', 'revocation', scope, { revoked_artifact_id: row.envelope['artifact_id'] });
        return reply(200, { artifact_id: row.envelope['artifact_id'], status: 'revoked', revocation_artifact: revocation });
      }
      if (method === 'GET') return reply(200, { envelope: row.envelope, payload: row.payload, status: row.status, revoked_at: row.revoked_at });
    }
    if (method === 'GET' && pathname === `/status/oacp/${listId}`) {
      return reply(200, statusListToken(), { 'content-type': 'application/statuslist+jwt' });
    }
    if (method === 'GET' && pathname === '/.well-known/jwks.json') return reply(200, jwks);
    return reply(404, { code: 'not_found', path });
  };

  const http = {
    doRequestWithToken: (method: string, path: string, token: string, body?: unknown) => {
      tokens.push(token);
      return Promise.resolve(route(method, path, body));
    },
    requestPublic: (method: string, path: string, body?: unknown) => Promise.resolve(route(method, path, body)),
  } as unknown as ConformanceHttpClient;

  return { http, tokens, rows };
}

function context(http: ConformanceHttpClient, overrides: Partial<SuiteContext> = {}): SuiteContext {
  return {
    baseUrl: BASE,
    apiKey: 'gx_test_operator_key_placeholder',
    http,
    flow: {} as SuiteContext['flow'],
    cleanup: {} as SuiteContext['cleanup'],
    sharedAgent: { agentId: '', agentDid: '', name: '' },
    internalToken: 'internal_token_placeholder_value',
    ...overrides,
  };
}

const verifier: OacpVerifierModule = {
  verifyOacpArtifact: (envelope, payload, options) => sdk.verifyOacpArtifact(envelope, payload, options),
  readOacpStatus: (options) => sdk.readOacpStatus(options),
};

const run = (http: ConformanceHttpClient, overrides: Partial<SuiteContext> = {}, load = async () => verifier) =>
  createOacpSuite({ loadVerifier: load, now: () => NOW }).run(context(http, overrides));

const byStatus = (results: TestResult[]) => ({
  pass: results.filter((r) => r.status === 'pass').map((r) => r.name),
  fail: results.filter((r) => r.status === 'fail').map((r) => `${r.name}: ${r.error ?? ''}`),
  skip: results.filter((r) => r.status === 'skip').map((r) => r.name),
});

describe('oacp suite', () => {
  it('passes every step against a conforming service and uses the internal token', async () => {
    const server = fakeAuthService();
    const results = await run(server.http);
    const summary = byStatus(results);
    expect(summary.fail).toEqual([]);
    expect(summary.skip).toEqual([]);
    expect(summary.pass).toHaveLength(9);
    expect(new Set(server.tokens)).toEqual(new Set(['internal_token_placeholder_value']));
    const revoked = [...server.rows.values()].filter((row) => row.status === 'revoked');
    expect(revoked).toHaveLength(1);
  });

  it('falls back to the API key without an internal token', async () => {
    const server = fakeAuthService();
    const results = await run(server.http, { internalToken: undefined });
    expect(byStatus(results).fail).toEqual([]);
    expect(new Set(server.tokens)).toEqual(new Set(['gx_test_operator_key_placeholder']));
  });

  it('fails the issue step for template signatures and skips the rest', async () => {
    const results = await run(fakeAuthService({ templateSignature: true }).http);
    const summary = byStatus(results);
    expect(summary.fail).toHaveLength(1);
    expect(summary.fail[0]).toMatch(/detached JWS/);
    expect(summary.skip).toHaveLength(8);
  });

  it('fails verification when artifacts are signed with an unpublished key', async () => {
    const results = await run(fakeAuthService({ foreignKey: true }).http);
    const failed = byStatus(results).fail.join('\n');
    expect(failed).toMatch(/verify: the SDK verifier accepts every issued artifact: .*detached_jws_verification_failed/);
  });

  it('fails the status flip when revoke leaves the list VALID', async () => {
    const results = await run(fakeAuthService({ revokeWithoutStatus: true }).http);
    const failed = byStatus(results).fail;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^status flips/);
  });

  it('pins the issuer: a different --oacp-issuer fails the issue step', async () => {
    const results = await run(fakeAuthService().http, { oacpIssuer: 'https://other.example' });
    expect(byStatus(results).fail[0]).toMatch(/envelope\.issuer/);
  });

  it('reports a missing SDK verifier on the steps that need it', async () => {
    const results = await run(fakeAuthService().http, {}, async () => { throw new Error('no verifier installed'); });
    const summary = byStatus(results);
    expect(summary.pass).toEqual([
      'issue: an authority request issues signed OACP artifacts',
      'persist: the issued artifact reads back unchanged',
      'persist: replay lists the issued artifacts for the scope',
      'revoke: the artifact is revoked and reads back revoked',
    ]);
    expect(summary.fail.every((line) => line.includes('no verifier installed'))).toBe(true);
  });
});
