/**
 * OACP arbiter decisions (G16) with the database mocked: service-token auth,
 * validation, the machine-profile decision grant (signed by the platform key,
 * verified with the service's JWKS), refusals minting nothing, idempotency,
 * and every human-approval consumer refusing a `policy_arbiter` token.
 * Persistence against real Postgres is in commerce-ledger-postgres.integration.test.ts.
 */
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildJwks } from '../src/lib/crypto.js';
import { config } from '../src/config.js';
import {
  arbiterDecisionFingerprint,
  arbiterEvidenceMethods,
  parseArbiterDecision,
  recordArbiterDecision,
} from '../src/lib/commerce/oacp-arbiter-decisions.js';
import { CommerceHttpError } from '../src/lib/commerce/errors.js';
import { DecisionError, DecisionSubReason } from '../src/lib/decisions/policy.js';
import { consumePresentedDecisionGrants } from '../src/lib/decisions/store.js';
import {
  DECISION_GRANT_AUDIENCE,
  DECISION_GRANT_TYP,
  DecisionTokenError,
  POLICY_ARBITER_APPROVER_AUTH,
  signArbiterDecisionGrant,
  signDecisionGrant,
  verifyDecisionGrantSignature,
} from '../src/lib/decisions/token.js';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';

const SERVICE_TOKEN = 'agenticorg-arbiter-fixture-service-key';
const TENANT = 'cten_ARBITER';
const HASH = 'a'.repeat(64);

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    decision_id: 'arb_dec_0001',
    tenant_id: TENANT,
    merchant_id: 'mch_example',
    seller_agent_id: 'seller-01',
    buyer_agent_id: 'shopper-01',
    action: 'purchase_handoff',
    action_hash: HASH,
    outcome: 'allow',
    rules_evaluated: ['mandate_present', 'consent_granted', 'passport_cap'],
    failing_rule: null,
    evidence: {
      mandate_ref: 'mandate:01',
      mandate_hash: 'b'.repeat(64),
      consent_ref: 'consent:01',
      consent_status: 'granted',
      passport_ref: 'passport:01',
      artifact_ids: ['oacp_art_01'],
    },
    decided_at: new Date().toISOString(),
    policy_version: '2026-10-01',
    ...overrides,
  };
}

function refusal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return decision({
    decision_id: 'arb_dec_0002',
    outcome: 'refuse',
    failing_rule: 'mandate_present',
    evidence: {
      mandate_ref: null, mandate_hash: null, consent_ref: 'consent:01', consent_status: 'granted',
      passport_ref: 'passport:01', artifact_ids: [],
    },
    ...overrides,
  });
}

/** Mocks: no stored decision, then the INSERT returns what it was given. */
function mockFreshInsert(): void {
  sqlMock.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join('?') : String(strings);
    if (text.includes('INSERT INTO commerce_arbiter_decisions')) {
      // decision_id, outcome, request_hash, grant_jti, grant_claims by position.
      return Promise.resolve([{ decision_id: values[0], outcome: values[7], request_hash: values[13], grant_jti: values[14], grant_claims: values[15] }]);
    }
    return Promise.resolve([]);
  });
}

async function verifyWithServiceJwks(token: string) {
  const jwks = createLocalJWKSet(await buildJwks() as never);
  return jwtVerify(token, jwks, { issuer: config.jwtIssuer, audience: DECISION_GRANT_AUDIENCE, typ: DECISION_GRANT_TYP });
}

describe('OACP arbiter decisions', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TOKEN', SERVICE_TOKEN);
    vi.stubEnv('COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS', TENANT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  const post = (payload: unknown, token = SERVICE_TOKEN) => app.inject({
    method: 'POST',
    url: '/v1/commerce/oacp/arbiter-decisions',
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>,
  });

  describe('authentication', () => {
    it('refuses a request without a bearer token', async () => {
      const res = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', payload: decision() });
      expect(res.statusCode).toBe(401);
    });

    it('refuses a developer API key: only the arbiter service decides', async () => {
      seedAuth();
      sqlMock.mockResolvedValueOnce([{ tenant_id: TENANT, status: 'active', role: 'owner' }]);
      const res = await app.inject({ method: 'POST', url: '/v1/commerce/oacp/arbiter-decisions', headers: authHeader(), payload: decision() });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('forbidden');
    });

    it('refuses the service token for a tenant outside the allowlist', async () => {
      const res = await post(decision({ tenant_id: 'cten_OTHER' }));
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('service_tenant_not_allowed');
    });

    it('does not accept the service token on other commerce routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/commerce/merchants/mch_example', headers: { authorization: `Bearer ${SERVICE_TOKEN}` } });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('validation', () => {
    it.each([
      ['an allow naming a failing rule', decision({ failing_rule: 'mandate_present' })],
      ['a refusal naming no failing rule', refusal({ failing_rule: null })],
      ['a failing rule that was not evaluated', refusal({ failing_rule: 'unknown_rule' })],
      ['an action_hash that is not lowercase hex SHA-256', decision({ action_hash: `sha256:${'A'.repeat(43)}` })],
      ['an unknown member', decision({ approved_by: 'ops@example.com' })],
      ['an unknown evidence member', decision({ evidence: { ...(decision()['evidence'] as object), reviewer: 'x' } })],
      ['a missing evidence member', decision({ evidence: { mandate_ref: 'm', mandate_hash: 'h', consent_ref: null, consent_status: null, artifact_ids: [] } })],
      ['an outcome other than allow or refuse', decision({ outcome: 'escalate' })],
      ['no rules evaluated', decision({ rules_evaluated: [] })],
      ['a decided_at that is not a timestamp', decision({ decided_at: 'yesterday' })],
    ])('refuses %s with 422 and records nothing', async (_name, body) => {
      const res = await post(body);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('arbiter_decision_invalid');
      expect(sqlMock).not.toHaveBeenCalled();
    });

    it('refuses an allow that rests on no evidence', async () => {
      const res = await post(decision({ evidence: { mandate_ref: null, mandate_hash: null, consent_ref: null, consent_status: null, passport_ref: null, artifact_ids: [] } }));
      expect(res.statusCode).toBe(422);
      const calls = sqlMock.mock.calls.map((c) => String((c[0] as string[]).join('?')));
      expect(calls.some((t) => t.includes('INSERT'))).toBe(false);
    });

    it('refuses a decision from the future and a stale allow', async () => {
      const future = await post(decision({ decided_at: new Date(Date.now() + 5 * 60_000).toISOString() }));
      expect(future.statusCode).toBe(422);
      const stale = await post(decision({ decided_at: new Date(Date.now() - 11 * 60_000).toISOString() }));
      expect(stale.statusCode).toBe(422);
      expect(stale.json<{ error: { code: string } }>().error.code).toBe('arbiter_decision_stale');
    });

    it('derives amr from the evidence, in a fixed order', () => {
      const parsed = parseArbiterDecision(decision());
      expect(arbiterEvidenceMethods(parsed.evidence)).toEqual(['mandate', 'consent', 'passport', 'oacp_artifact']);
      // A mandate reference without its hash is not mandate evidence.
      expect(arbiterEvidenceMethods({ ...parsed.evidence, mandate_hash: null })).toEqual(['consent', 'passport', 'oacp_artifact']);
    });
  });

  describe('allow', () => {
    it('answers with a machine-profile decision grant that verifies with the service JWKS', async () => {
      mockFreshInsert();
      const body = decision();
      const res = await post(body);
      expect(res.statusCode, res.body).toBe(201);
      const answer = res.json<{ decision_id: string; outcome: string; decision_grant: string; jti: string; exp: number; expires_at: string }>();
      expect(answer.outcome).toBe('allow');
      const header = decodeProtectedHeader(answer.decision_grant);
      expect(header.typ).toBe('decision+jwt');
      expect(typeof header.kid).toBe('string');
      const { payload } = await verifyWithServiceJwks(answer.decision_grant);
      expect(payload).toMatchObject({
        sub: 'shopper-01',
        jti: answer.jti,
        exp: answer.exp,
        approver_auth: POLICY_ARBITER_APPROVER_AUTH,
        amr: ['mandate', 'consent', 'passport', 'oacp_artifact'],
        dwell_ms: 0,
        dwell_source: 'server',
        action_hash: HASH,
        decision_request: 'arb_dec_0001',
        arbiter: {
          tenant_id: TENANT,
          merchant_id: 'mch_example',
          seller_agent_id: 'seller-01',
          action: 'purchase_handoff',
          policy_version: '2026-10-01',
          rules_evaluated: ['mandate_present', 'consent_granted', 'passport_cap'],
        },
      });
      expect(payload['acr']).toBeUndefined();
      expect(payload['idp']).toBeUndefined();
      expect(payload['four_eyes']).toBeUndefined();
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
      expect(payload.exp! - payload.iat!).toBeGreaterThan(0);
      expect(answer.expires_at).toBe(new Date(answer.exp * 1000).toISOString());
    });

    it('answers a replay of the same body with the same grant, and a different body with 409', async () => {
      const body = decision();
      const fingerprint = arbiterDecisionFingerprint(parseArbiterDecision(body));
      const claims = {
        sub: 'shopper-01', jti: 'dgnt_01K8Z000000000000000000AR1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
        approver_auth: 'policy_arbiter', amr: ['mandate'], auth_time: Math.floor(Date.now() / 1000), action_hash: HASH,
        dwell_ms: 0, dwell_source: 'server', decision_request: 'arb_dec_0001',
        arbiter: { tenant_id: TENANT, merchant_id: 'mch_example', seller_agent_id: 'seller-01', action: 'purchase_handoff', policy_version: '2026-10-01', rules_evaluated: ['mandate_present'], evidence_hash: HASH },
      };
      const stored = [{ decision_id: 'arb_dec_0001', outcome: 'allow', request_hash: fingerprint, grant_jti: claims.jti, grant_claims: claims }];
      sqlMock.mockResolvedValueOnce(stored);
      const replay = await post(body);
      expect(replay.statusCode).toBe(200);
      expect(replay.json<{ jti: string; exp: number }>()).toMatchObject({ jti: claims.jti, exp: claims.exp });
      const calls = sqlMock.mock.calls.map((c) => String((c[0] as string[]).join('?')));
      expect(calls.some((t) => t.includes('INSERT'))).toBe(false);

      sqlMock.mockResolvedValueOnce(stored);
      const changed = await post({ ...body, policy_version: '2026-10-02' });
      expect(changed.statusCode).toBe(409);
      expect(changed.json<{ error: { code: string; details: { decision_id: string } } }>().error).toMatchObject({
        code: 'arbiter_decision_conflict', details: { decision_id: 'arb_dec_0001' },
      });
    });
  });

  describe('refuse', () => {
    it('is recorded and answered without any token', async () => {
      mockFreshInsert();
      const res = await post(refusal());
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toEqual({ decision_id: 'arb_dec_0002', outcome: 'refuse', recorded: true });
      const insert = sqlMock.mock.calls.find((c) => String((c[0] as string[]).join('?')).includes('INSERT INTO commerce_arbiter_decisions'));
      expect(insert).toBeDefined();
      // grant_jti, grant_claims, grant_expires_at
      expect(insert!.slice(1)[14]).toBeNull();
      expect(insert!.slice(1)[15]).toBeNull();
      expect(insert!.slice(1)[16]).toBeNull();
    });

    it('a race lost to a refusal with the same body answers recorded, never a token', async () => {
      const body = refusal();
      const fingerprint = arbiterDecisionFingerprint(parseArbiterDecision(body));
      sqlMock
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ decision_id: 'arb_dec_0002', outcome: 'refuse', request_hash: fingerprint, grant_jti: null, grant_claims: null }]);
      const res = await post(body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ decision_id: 'arb_dec_0002', outcome: 'refuse', recorded: true });
    });
  });

  describe('human-approval consumers refuse a machine-profile grant', () => {
    async function arbiterToken(): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      return signArbiterDecisionGrant({
        sub: 'shopper-01', jti: 'dgnt_01K8Z000000000000000000AR2', iat: now, exp: now + 300,
        approver_auth: 'policy_arbiter', amr: ['mandate', 'consent'], auth_time: now, action_hash: HASH,
        dwell_ms: 0, dwell_source: 'server', decision_request: 'arb_dec_0003',
        arbiter: { tenant_id: TENANT, merchant_id: 'mch_example', seller_agent_id: 'seller-01', action: 'purchase_handoff', policy_version: '2026-10-01', rules_evaluated: ['mandate_present'], evidence_hash: HASH },
      });
    }

    it('the service verifier (verifyDecisionGrantSignature) refuses it after the signature verifies', async () => {
      const token = await arbiterToken();
      await expect(verifyWithServiceJwks(token)).resolves.toBeDefined();
      await expect(verifyDecisionGrantSignature(token)).rejects.toThrow(/policy_arbiter decision grant is a machine decision/);
    });

    it('a human-shaped grant claiming policy_arbiter is refused too, and cannot be signed as human', async () => {
      const now = Math.floor(Date.now() / 1000);
      const human = {
        sub: 'user:approver-a', jti: 'dgnt_01K8Z000000000000000000AR3', iat: now, exp: now + 300,
        dev: 'dev_TEST', idp: 'https://idp.example.com', approver_auth: 'sso+hwk', amr: ['hwk'], auth_time: now,
        action: { case_id: 'case_1', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' },
        action_hash: `sha256:${'A'.repeat(43)}`, connector: 'acme_kyb', case_version: 'v1', dwell_ms: 60_000,
        dwell_source: 'server' as const, decision_request: 'dreq_01K8Z000000000000000000QR1',
        memo_hash: `sha256:${'M'.repeat(43)}`, policy_score_hash: `sha256:${'P'.repeat(43)}`,
      };
      await expect(signDecisionGrant({ ...human, approver_auth: 'policy_arbiter' })).rejects.toBeInstanceOf(DecisionTokenError);
      // Signed through the machine signer's key path with the human claims, it still fails the human parser.
      const forged = await signArbiterDecisionGrant({
        ...(human as unknown as Parameters<typeof signArbiterDecisionGrant>[0]),
        approver_auth: 'policy_arbiter', dwell_ms: 0,
      });
      await expect(verifyDecisionGrantSignature(forged)).rejects.toThrow(/machine decision/);
    });

    it('the machine signer refuses a lifetime over ten minutes, an acr, or a dwell', async () => {
      const now = Math.floor(Date.now() / 1000);
      const base = {
        sub: 'shopper-01', jti: 'dgnt_01K8Z000000000000000000AR4', iat: now, exp: now + 300,
        approver_auth: 'policy_arbiter' as const, amr: ['mandate'], auth_time: now, action_hash: HASH,
        dwell_ms: 0 as const, dwell_source: 'server' as const, decision_request: 'arb_dec_0004',
        arbiter: { tenant_id: TENANT, merchant_id: 'mch_example', seller_agent_id: 'seller-01', action: 'purchase_handoff', policy_version: '1', rules_evaluated: ['r'], evidence_hash: HASH },
      };
      await expect(signArbiterDecisionGrant({ ...base, exp: now + 601 })).rejects.toBeInstanceOf(DecisionTokenError);
      await expect(signArbiterDecisionGrant({ ...base, acr: 'phr' } as never)).rejects.toBeInstanceOf(DecisionTokenError);
      await expect(signArbiterDecisionGrant({ ...base, dwell_ms: 5 } as never)).rejects.toBeInstanceOf(DecisionTokenError);
    });

    it('consumePresentedDecisionGrants refuses it as malformed before touching any decision row', async () => {
      const token = await arbiterToken();
      const err = await consumePresentedDecisionGrants(sqlMock as never, {
        developerId: 'dev_TEST',
        tokens: [token],
        action: { case_id: 'case_1', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' },
        caseVersion: 'v1',
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DecisionError);
      expect((err as DecisionError).subReason).toBe(DecisionSubReason.MALFORMED);
      expect(sqlMock.begin).not.toHaveBeenCalled();
    });

    it('POST /v1/decisions/consume refuses it (400 malformed), records the refusal and consumes nothing', async () => {
      vi.stubEnv('DECISION_GRANTS_ENABLED', 'true');
      const token = await arbiterToken();
      seedAuth();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/decisions/consume',
        headers: authHeader(),
        payload: {
          decisionGrants: [token],
          action: { case_id: 'case_1', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' },
          caseVersion: 'v1',
        },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ reason: 'decision_invalid', subReason: 'malformed' });
      const statements = sqlMock.mock.calls.map((c) => String((c[0] as string[]).join('?')));
      expect(statements.some((t) => t.includes('UPDATE decision_grants'))).toBe(false);
      // The refusal is recorded in the audit chain, and no jti is credited to the token.
      const auditInsert = sqlMock.mock.calls.find((c) => String((c[0] as string[]).join('?')).includes('INSERT INTO audit_entries'));
      expect(auditInsert).toBeDefined();
      expect(JSON.stringify(auditInsert)).toContain('decision.consume_refused');
      expect(JSON.stringify(auditInsert)).not.toContain('dgnt_01K8Z000000000000000000AR2');
    });
  });

  it('recordArbiterDecision raises CommerceHttpError for malformed input', async () => {
    await expect(recordArbiterDecision(sqlMock as never, 'not an object', 'svc')).rejects.toBeInstanceOf(CommerceHttpError);
  });
});
