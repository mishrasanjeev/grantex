/**
 * Audit witness checkpoints (G16) with the database mocked: service-token
 * auth, validation, the countersignature (platform key, `audit-witness+jwt`,
 * verifiable with the service JWKS), idempotent replay and WITNESS_FORK.
 * Persistence against real Postgres is in commerce-ledger-postgres.integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJwks } from '../src/lib/crypto.js';
import { config } from '../src/config.js';
import { AUDIT_WITNESS_TYP } from '../src/lib/audit-witness.js';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';

const SERVICE_TOKEN = 'agenticorg-witness-fixture-service-key';
const HEAD = '1'.repeat(64);

function checkpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'agenticorg',
    tenant_ref: 'tenant-0001',
    chain: 'audit_log',
    head_seq: 42,
    head_hash: HEAD,
    anchored_at: '2026-10-19T10:00:00Z',
    ...overrides,
  };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    witness_id: 'awit_01K8Z000000000000000000WT1',
    source: 'agenticorg',
    tenant_ref: 'tenant-0001',
    chain: 'audit_log',
    head_seq: '42',
    head_hash: HEAD,
    anchored_at: new Date('2026-10-19T10:00:00Z'),
    witnessed_at: new Date('2026-10-19T10:00:05Z'),
    countersignature: 'stored.countersignature.value',
    ...overrides,
  };
}

const statementText = (call: unknown[]) => String((call[0] as string[]).join('?'));

describe('audit witness checkpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  const post = (payload: unknown, token: string | null = SERVICE_TOKEN) => app.inject({
    method: 'POST',
    url: '/v1/audit/witness-checkpoints',
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });

  it('refuses a missing token, a wrong token and a developer API key', async () => {
    expect((await post(checkpoint(), null)).statusCode).toBe(401);
    expect((await post(checkpoint(), 'not-the-service-token-at-all')).statusCode).toBe(401);
    seedAuth();
    const dev = await app.inject({ method: 'POST', url: '/v1/audit/witness-checkpoints', headers: authHeader(), payload: checkpoint() });
    expect(dev.statusCode).toBe(401);
    const read = await app.inject({ method: 'GET', url: '/v1/audit/witness-checkpoints?source=agenticorg&tenant_ref=tenant-0001', headers: authHeader() });
    expect(read.statusCode).toBe(401);
    expect(sqlMock.mock.calls.some((c) => statementText(c).includes('audit_witness'))).toBe(false);
  });

  it('accepts the service token by its SHA-256 as well', async () => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', '');
    const { createHash } = await import('node:crypto');
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN_SHA256', createHash('sha256').update(SERVICE_TOKEN).digest('hex'));
    const res = await app.inject({ method: 'GET', url: '/v1/audit/witness-checkpoints?source=agenticorg&tenant_ref=tenant-0001', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['another source', checkpoint({ source: 'elsewhere' })],
    ['another chain', checkpoint({ chain: 'payments' })],
    ['a negative head_seq', checkpoint({ head_seq: -1 })],
    ['a fractional head_seq', checkpoint({ head_seq: 1.5 })],
    ['a head_hash that is not lowercase hex SHA-256', checkpoint({ head_hash: 'A'.repeat(64) })],
    ['an anchored_at in the future', checkpoint({ anchored_at: new Date(Date.now() + 3_600_000).toISOString() })],
    ['an unknown member', checkpoint({ signature: 'x' })],
    ['a missing tenant_ref', checkpoint({ tenant_ref: undefined })],
  ])('refuses %s with 400 and stores nothing', async (_name, body) => {
    const res = await post(JSON.parse(JSON.stringify(body)));
    expect(res.statusCode, res.body).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('stores a new head and answers a countersignature that verifies with the service JWKS', async () => {
    sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (statementText([strings]).includes('INSERT INTO audit_witness_checkpoints')) {
        return Promise.resolve([storedRow({
          witness_id: values[0], anchored_at: new Date(values[6] as string), witnessed_at: new Date(values[7] as string), countersignature: values[8],
        })]);
      }
      return Promise.resolve([]);
    });
    const res = await post(checkpoint());
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ witness_id: string; countersignature: string; witnessed_at: string; created: boolean }>();
    expect(body.witness_id).toMatch(/^awit_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(body.created).toBe(true);
    const header = decodeProtectedHeader(body.countersignature);
    expect(header.typ).toBe(AUDIT_WITNESS_TYP);
    expect(typeof header.kid).toBe('string');
    const { payload } = await jwtVerify(body.countersignature, createLocalJWKSet(await buildJwks() as never), {
      issuer: config.jwtIssuer, typ: AUDIT_WITNESS_TYP,
    });
    expect(payload).toMatchObject({
      jti: body.witness_id,
      source: 'agenticorg',
      tenant_ref: 'tenant-0001',
      chain: 'audit_log',
      head_seq: 42,
      head_hash: HEAD,
      anchored_at: '2026-10-19T10:00:00.000Z',
      witnessed_at: body.witnessed_at,
    });
    expect(payload.exp).toBeUndefined();
  });

  it('answers a replay of a witnessed head with the stored witness', async () => {
    sqlMock.mockResolvedValueOnce([storedRow()]);
    const res = await post(checkpoint({ anchored_at: '2026-10-19T10:00:30Z' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ witness_id: 'awit_01K8Z000000000000000000WT1', countersignature: 'stored.countersignature.value', created: false });
    expect(sqlMock.mock.calls.some((c) => statementText(c).includes('INSERT'))).toBe(false);
  });

  it('refuses a different hash at a witnessed position with WITNESS_FORK, records it, and returns the stored evidence', async () => {
    sqlMock.mockResolvedValueOnce([storedRow()]);
    const forged = '2'.repeat(64);
    const res = await post(checkpoint({ head_hash: forged }));
    expect(res.statusCode).toBe(409);
    const body = res.json<{ code: string; fork: Record<string, unknown> }>();
    expect(body.code).toBe('WITNESS_FORK');
    expect(body.fork).toMatchObject({
      source: 'agenticorg', tenant_ref: 'tenant-0001', chain: 'audit_log', head_seq: 42,
      witnessed: { witness_id: 'awit_01K8Z000000000000000000WT1', head_hash: HEAD, countersignature: 'stored.countersignature.value' },
      presented: { head_hash: forged },
    });
    expect(String(body.fork['fork_id'])).toMatch(/^awfk_/);
    const forkInsert = sqlMock.mock.calls.find((c) => statementText(c).includes('INSERT INTO audit_witness_forks'));
    expect(forkInsert).toBeDefined();
    expect(forkInsert).toContain(forged);
    expect(sqlMock.mock.calls.some((c) => statementText(c).includes('INSERT INTO audit_witness_checkpoints'))).toBe(false);
  });

  it('validates the read-back query', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/audit/witness-checkpoints?source=agenticorg', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(res.statusCode).toBe(400);
    const limit = await app.inject({ method: 'GET', url: '/v1/audit/witness-checkpoints?source=agenticorg&tenant_ref=t1&limit=5000', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
    expect(limit.statusCode).toBe(400);
  });
});
