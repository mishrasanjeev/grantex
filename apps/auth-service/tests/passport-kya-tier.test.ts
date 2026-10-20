// SPDX-License-Identifier: Apache-2.0
/**
 * KYA tier on the Agent Passport (G54): the operator's mapping table, the
 * mapping from counted trust marks, and the claim on an issued passport only
 * with AGENT_PASSPORT_KYA_TIER_ENABLED. The registry's trust computation is
 * stubbed; its own behaviour is covered by the registry tests.
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authHeader, buildTestApp, seedAuth, sqlMock, TEST_AGENT } from './helpers.js';

vi.mock('../src/lib/registry/trust-level.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/registry/trust-level.js')>()),
  computeAgentTrust: vi.fn(),
}));

const { computeAgentTrust } = await import('../src/lib/registry/trust-level.js');
const { EMPTY_KYA_TIER_MAP, KyaTierMapError, kyaTierFor, parseKyaTierMap } = await import('../src/lib/registry/kya-tier.js');

const MAP = JSON.stringify({
  version: '2026-10-pending-scheme-specs',
  tiers: [
    { tier: 'tier-2', trust_marks: ['urn:grantex:tm:agent.identity', 'urn:grantex:tm:agent.security', 'urn:grantex:tm:provider.entity'] },
    { tier: 'tier-1', trust_marks: ['urn:grantex:tm:agent.identity'] },
  ],
});

describe('the mapping table', () => {
  it('is empty by default, so no tier is ever derived', () => {
    expect(parseKyaTierMap(undefined)).toBe(EMPTY_KYA_TIER_MAP);
    expect(kyaTierFor(['urn:grantex:tm:agent.identity'], EMPTY_KYA_TIER_MAP)).toBeNull();
  });

  it('maps the first entry whose trust marks are all counted, passing the label through', () => {
    const map = parseKyaTierMap(MAP);
    expect(kyaTierFor(['urn:grantex:tm:agent.identity', 'urn:grantex:tm:provider.entity'], map)).toEqual({
      tier: 'tier-1', trustMarks: ['urn:grantex:tm:agent.identity'], mappingVersion: '2026-10-pending-scheme-specs',
    });
    expect(kyaTierFor(['urn:grantex:tm:agent.identity', 'urn:grantex:tm:agent.security', 'urn:grantex:tm:provider.entity'], map)?.tier).toBe('tier-2');
    expect(kyaTierFor(['urn:grantex:tm:provider.entity'], map)).toBeNull();
  });

  it('refuses a table outside the shape', () => {
    for (const bad of [
      'not json',
      '[]',
      JSON.stringify({ version: 'v1', tiers: [{ tier: 'a', trust_marks: ['urn:grantex:tm:unknown'] }] }),
      JSON.stringify({ version: 'v1', tiers: [{ tier: 'a', trust_marks: [] }] }),
      JSON.stringify({ version: 'v1', tiers: [{ tier: 'a b', trust_marks: ['urn:grantex:tm:agent.identity'] }] }),
      JSON.stringify({ version: 'v1', tiers: [{ tier: 'a', trust_marks: ['urn:grantex:tm:agent.identity'], meaning: 'x' }] }),
      JSON.stringify({ version: 'v1', tiers: [{ tier: 'a', trust_marks: ['urn:grantex:tm:agent.identity'] }, { tier: 'a', trust_marks: ['urn:grantex:tm:agent.security'] }] }),
      JSON.stringify({ tiers: [] }),
    ]) {
      expect(() => parseKyaTierMap(bad), bad).toThrow(KyaTierMapError);
    }
  });
});

describe('POST /v1/passport/issue with a KYA tier', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(computeAgentTrust).mockReset();
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
  });

  async function issue() {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: TEST_AGENT.id, did: TEST_AGENT.did }]);
    sqlMock.mockResolvedValueOnce([{
      id: 'grnt_MPP01', scopes: ['payments:mpp:inference'], principal_id: 'user_123', status: 'active',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(), delegation_depth: 0,
    }]);
    sqlMock.mockResolvedValueOnce([]); // budget
    sqlMock.mockResolvedValueOnce([{ id: 'vcsl_PP01', nextIndex: 0, next_index: 0 }]);
    const res = await app.inject({
      method: 'POST', url: '/v1/passport/issue', headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, grantId: 'grnt_MPP01', allowedMPPCategories: ['inference'], maxTransactionAmount: { amount: 100, currency: 'USDC' } },
    });
    return res;
  }

  const trust = (types: string[]) => ({
    agent_id: TEST_AGENT.id, agent_did: TEST_AGENT.did, provider_did: null, level: 'attested' as const, flags: [],
    issuers: ['https://issuer.example'], types, attestation_ids: ['ratt_1'], declared_limits: null, stale_attestation_ids: [],
  });

  it('off: no claim and the registry is not read', async () => {
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_MAP', MAP);
    const res = await issue();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().credential.credentialSubject.kyaTier).toBeUndefined();
    expect(computeAgentTrust).not.toHaveBeenCalled();
  });

  it('on with the default empty table: no claim', async () => {
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_ENABLED', 'true');
    const res = await issue();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().credential.credentialSubject.kyaTier).toBeUndefined();
    expect(computeAgentTrust).not.toHaveBeenCalled();
  });

  it('on with a table: the claim names the tier, its trust marks and the mapping version', async () => {
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_ENABLED', 'true');
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_MAP', MAP);
    vi.mocked(computeAgentTrust).mockResolvedValue(trust(['urn:grantex:tm:agent.identity', 'urn:grantex:tm:provider.entity']));
    const res = await issue();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().credential.credentialSubject.kyaTier).toEqual({
      tier: 'tier-1', trustMarks: ['urn:grantex:tm:agent.identity'], mappingVersion: '2026-10-pending-scheme-specs',
    });
    expect(vi.mocked(computeAgentTrust).mock.calls[0]![1]).toBe(TEST_AGENT.did);
  });

  it('on with a table, an agent with no matching trust marks: no claim', async () => {
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_ENABLED', 'true');
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_MAP', MAP);
    vi.mocked(computeAgentTrust).mockResolvedValue(trust([]));
    const res = await issue();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().credential.credentialSubject.kyaTier).toBeUndefined();
  });

  it('on with a table that does not parse: issuance is refused, not issued without the claim', async () => {
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_ENABLED', 'true');
    vi.stubEnv('AGENT_PASSPORT_KYA_TIER_MAP', '{"version":"v1","tiers":[{"tier":"x","trust_marks":["nope"]}]}');
    const res = await issue();
    expect(res.statusCode).toBe(500);
  });
});
