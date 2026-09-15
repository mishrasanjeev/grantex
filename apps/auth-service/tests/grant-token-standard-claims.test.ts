import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import type { FastifyInstance } from 'fastify';
import { config } from '../src/config.js';
import {
  getKeyPair,
  initKeys,
  signGrantToken,
  verifyGrantToken,
  type GrantTokenPayload,
} from '../src/lib/crypto.js';
import { checkActiveGrantToken } from '../src/lib/active-grant-token.js';
import {
  GRANT_CLAIM,
  GrantTokenClaimsError,
  LEGACY_GRANT_TOKEN_CLAIMS,
  delegatedActorClaim,
  grantTokenClaimsStartupNotices,
  parseActorClaim,
} from '../src/lib/grant-token-claims.js';
import { parseBooleanSetting } from '../src/config.js';
import {
  authHeader,
  buildTestApp,
  mockRedis,
  seedAuth,
  sqlMock,
  TEST_AGENT,
  TEST_DEVELOPER,
} from './helpers.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = JSON.parse(readFileSync(join(repoRoot, 'spec', 'examples', 'grant-token-0.6.json'), 'utf8')) as {
  header: Record<string, unknown>;
  standard: Record<string, unknown> & {
    scope: string;
    act: { sub: string };
    authorization_details: Array<Record<string, unknown>>;
    cnf: { jkt: string };
    [GRANT_CLAIM]: { grant_id: string; agent_did: string; developer_id: string; parent_grant_id: string; delegation_depth: number };
  };
  legacy_aliases: Record<string, unknown>;
};

type Mutable = { jwtIssuer: string; jwtSigningAlg: 'RS256' | 'ES256'; ecPrivateKey: string | null; autoGenerateKeys: boolean };
const mutable = config as unknown as Mutable;
const original: Mutable = {
  jwtIssuer: config.jwtIssuer,
  jwtSigningAlg: config.jwtSigningAlg,
  ecPrivateKey: config.ecPrivateKey,
  autoGenerateKeys: config.autoGenerateKeys,
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterEach(async () => {
  Object.assign(mutable, original);
  await initKeys();
});

afterAll(async () => {
  Object.assign(mutable, original);
  await initKeys();
});

function fixtureInput(overrides: Partial<GrantTokenPayload> = {}): GrantTokenPayload {
  const s = fixture.standard;
  const grant = s[GRANT_CLAIM];
  return {
    sub: s['sub'] as string,
    agt: grant.agent_did,
    dev: grant.developer_id,
    clientId: s['client_id'] as string,
    scp: s.scope.split(' '),
    jti: s['jti'] as string,
    grnt: grant.grant_id,
    aud: s['aud'] as string,
    iat: s['iat'] as number,
    exp: s['exp'] as number,
    cnf: s.cnf,
    act: s.act,
    authorizationDetails: s.authorization_details,
    parentAgt: s.act.sub,
    parentGrnt: grant.parent_grant_id,
    delegationDepth: grant.delegation_depth,
    ...overrides,
  };
}

describe('grant token claims match the 0.6 profile example', () => {
  it('issues exactly the standard payload when the compatibility flag is off', async () => {
    mutable.jwtIssuer = fixture.standard['iss'] as string;
    const token = await signGrantToken(fixtureInput(), { legacyClaims: false });
    expect(decodeJwt(token)).toEqual(fixture.standard);
    expect(decodeProtectedHeader(token)).toMatchObject({ typ: 'at+jwt' });
  });

  it('adds exactly the legacy aliases when the compatibility flag is on', async () => {
    mutable.jwtIssuer = fixture.standard['iss'] as string;
    const token = await signGrantToken(fixtureInput(), { legacyClaims: true });
    expect(decodeJwt(token)).toEqual({ ...fixture.standard, ...fixture.legacy_aliases });
    expect(Object.keys(fixture.legacy_aliases).every((alias) => alias in LEGACY_GRANT_TOKEN_CLAIMS)).toBe(true);
  });

  it('keeps the compatibility flag on by default for 0.6', async () => {
    expect(config.grantTokenLegacyClaims).toBe(true);
    const claims = decodeJwt(await signGrantToken(fixtureInput({ exp: Math.floor(Date.now() / 1000) + 60 })));
    expect(claims['agt']).toBe(fixture.legacy_aliases['agt']);
    expect(claims[GRANT_CLAIM]).toEqual(fixture.standard[GRANT_CLAIM]);
  });

  it('parses GRANT_TOKEN_LEGACY_CLAIMS strictly', () => {
    expect(parseBooleanSetting('GRANT_TOKEN_LEGACY_CLAIMS', 'true')).toBe(true);
    expect(parseBooleanSetting('GRANT_TOKEN_LEGACY_CLAIMS', 'false')).toBe(false);
    for (const value of ['', '0', 'off', 'TRUE', 'yes']) {
      expect(() => parseBooleanSetting('GRANT_TOKEN_LEGACY_CLAIMS', value)).toThrow('GRANT_TOKEN_LEGACY_CLAIMS must be true or false');
    }
  });
});

describe('a stock OAuth/JOSE verifier accepts the token using only standard semantics', () => {
  for (const alg of ['RS256', 'ES256'] as const) {
    it(`validates an ${alg} grant token with jose against the served JWK Set`, async () => {
      if (alg === 'ES256') {
        mutable.jwtSigningAlg = 'ES256';
        mutable.ecPrivateKey = await exportPKCS8((await generateKeyPair('ES256', { extractable: true })).privateKey);
        await initKeys();
      }
      const dpopKey = await generateKeyPair('ES256', { extractable: true });
      const jkt = await calculateJwkThumbprint(await exportJWK(dpopKey.publicKey), 'sha256');
      const now = Math.floor(Date.now() / 1000);
      const token = await signGrantToken(
        fixtureInput({ iat: now, exp: now + 600, cnf: { jkt } }),
        { legacyClaims: false },
      );

      const res = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
      const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(res.json()), {
        issuer: config.jwtIssuer,
        audience: 'https://agents.example.com',
        algorithms: ['RS256', 'ES256'],
        typ: 'at+jwt',
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope'],
      });

      expect(protectedHeader.alg).toBe(alg);
      expect(typeof payload['scope']).toBe('string');
      expect((payload['scope'] as string).split(' ')).toEqual(['tool:acme_kyb:read', 'tool:acme_kyb:write']);
      expect(payload['client_id']).toBe('ag_01UNDERWRITER');
      // RFC 9449: the sender's key thumbprint.
      expect((payload['cnf'] as { jkt: string }).jkt).toBe(jkt);
      // RFC 8693: nested actors.
      expect(payload['act']).toEqual({ sub: 'did:grantex:ag_01ORCHESTRATOR', act: { sub: 'did:grantex:ag_01INTAKE' } });
      // RFC 9396: purpose, caps and decision references.
      const details = payload['authorization_details'] as Array<Record<string, unknown>>;
      expect(details.find((d) => d['type'] === 'urn:grantex:tools:v1')).toMatchObject({
        purpose: 'aml.cdd.onboarding', caps: { verify_business: { per_hour: 50, per_case: 3 } },
      });
      expect(details.find((d) => d['type'] === 'urn:grantex:decision:v1')).toMatchObject({ tools: ['case_decision'] });
      for (const alias of Object.keys(LEGACY_GRANT_TOKEN_CLAIMS)) {
        expect(payload).not.toHaveProperty(alias);
      }
    });
  }
});

describe('the auth service reads both claim forms and refuses disagreement', () => {
  const exp = () => Math.floor(Date.now() / 1000) + 600;

  it('reads a standard-only token', async () => {
    const claims = await verifyGrantToken(await signGrantToken(fixtureInput({ exp: exp() }), { legacyClaims: false }));
    expect(claims).toMatchObject({
      agt: 'did:grantex:ag_01UNDERWRITER',
      dev: 'dev_01EXAMPLE',
      scp: ['tool:acme_kyb:read', 'tool:acme_kyb:write'],
      grnt: 'grnt_01EXAMPLECHILD',
      parentAgt: 'did:grantex:ag_01ORCHESTRATOR',
      parentGrnt: 'grnt_01EXAMPLEPARENT',
      delegationDepth: 2,
      clientId: 'ag_01UNDERWRITER',
    });
  });

  async function signRaw(claims: Record<string, unknown>): Promise<string> {
    const { privateKey, kid, alg } = getKeyPair();
    return new SignJWT(claims)
      .setProtectedHeader({ alg, kid, typ: 'at+jwt' })
      .setIssuer(config.jwtIssuer).setSubject('user_legacy').setJti('tok_legacy')
      .setIssuedAt().setExpirationTime(exp())
      .sign(privateKey);
  }

  it('reads a token issued before 0.6 with legacy claims only', async () => {
    const token = await signRaw({
      agt: 'did:grantex:ag_old', dev: 'dev_old', scp: ['read'], grnt: 'grnt_old',
      parentAgt: 'did:grantex:ag_parent', parentGrnt: 'grnt_parent', delegationDepth: 1,
    });
    await expect(verifyGrantToken(token)).resolves.toMatchObject({
      agt: 'did:grantex:ag_old', dev: 'dev_old', scp: ['read'], grnt: 'grnt_old',
      parentAgt: 'did:grantex:ag_parent', parentGrnt: 'grnt_parent', delegationDepth: 1,
    });
  });

  it.each([
    ['scope and scp', { [GRANT_CLAIM]: { agent_did: 'a', developer_id: 'd' }, scope: 'read write', scp: ['read'] }],
    ['agent_did and agt', { [GRANT_CLAIM]: { agent_did: 'did:grantex:ag_a', developer_id: 'dev' }, agt: 'did:grantex:ag_b', dev: 'dev', scope: 'read' }],
    ['grant_id and grnt', { [GRANT_CLAIM]: { agent_did: 'a', developer_id: 'd', grant_id: 'g1' }, grnt: 'g2', scope: 'read' }],
    ['act.sub and parentAgt', { [GRANT_CLAIM]: { agent_did: 'a', developer_id: 'd' }, scope: 'read', act: { sub: 'x' }, parentAgt: 'y' }],
    ['delegation_depth and delegationDepth', { [GRANT_CLAIM]: { agent_did: 'a', developer_id: 'd', delegation_depth: 1 }, delegationDepth: 2, scope: 'read' }],
  ])('refuses a token whose %s disagree', async (_name, claims) => {
    const token = await signRaw({ agt: 'a', dev: 'd', ...claims });
    await expect(verifyGrantToken(token)).rejects.toBeInstanceOf(GrantTokenClaimsError);
    await expect(checkActiveGrantToken(token)).resolves.toEqual({ ok: false, reason: 'invalid_claims' });
  });

  it.each([
    ['a non-object grant claim', { [GRANT_CLAIM]: 'grnt_1', scope: 'read', agt: 'a', dev: 'd' }],
    ['a non-string scope', { scope: ['read'], agt: 'a', dev: 'd' }],
    ['an act without sub', { scope: 'read', agt: 'a', dev: 'd', act: { iss: 'x' } }],
    ['a negative delegation depth', { scope: 'read', [GRANT_CLAIM]: { agent_did: 'a', developer_id: 'd', delegation_depth: -1 } }],
  ])('refuses %s', async (_name, claims) => {
    await expect(verifyGrantToken(await signRaw(claims))).rejects.toBeInstanceOf(GrantTokenClaimsError);
  });

  it('refuses a token missing the agent in both forms', async () => {
    await expect(verifyGrantToken(await signRaw({ scope: 'read', dev: 'd' }))).rejects.toThrow('Missing required grant token claims');
  });

});

describe('grants whose scopes contain whitespace (pre-0.6) keep working', () => {
  const exp = () => Math.floor(Date.now() / 1000) + 600;
  const base = { sub: 'user_ws', agt: 'did:grantex:ag_ws', dev: 'dev_ws', jti: 'tok_ws', grnt: 'grnt_ws' };

  it('issues their tokens without scope and with scp, whatever the compatibility flag', async () => {
    for (const legacyClaims of [true, false]) {
      const claims = decodeJwt(await signGrantToken({ ...base, scp: ['read files', 'write'], exp: exp() }, { legacyClaims }));
      expect(claims).not.toHaveProperty('scope');
      expect(claims['scp']).toEqual(['read files', 'write']);
      await expect(verifyGrantToken(await signGrantToken({ ...base, scp: ['read files'], exp: exp() }, { legacyClaims })))
        .resolves.toMatchObject({ scp: ['read files'] });
    }
  });

  it('verifies a token issued before 0.6, whose scope is a lossy join of scp', async () => {
    const { privateKey, kid, alg } = getKeyPair();
    const token = await new SignJWT({ agt: 'did:grantex:ag_ws', dev: 'dev_ws', scp: ['read files', 'write'], scope: 'read files write', grnt: 'grnt_ws' })
      .setProtectedHeader({ alg, kid, typ: 'at+jwt' })
      .setIssuer(config.jwtIssuer).setSubject('user_ws').setJti('tok_ws_old').setIssuedAt().setExpirationTime(exp())
      .sign(privateKey);
    await expect(verifyGrantToken(token)).resolves.toMatchObject({ scp: ['read files', 'write'] });
  });

  it('refreshes such a grant instead of failing', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      refresh_id: 'ref_WS', grant_id: 'grnt_WS', is_used: false,
      refresh_expires_at: new Date(Date.now() + 86400_000).toISOString(),
      used_at: null, rotated_to_token_id: null, replay_expires_at: null, replay_request_hash: null,
      replay_jti: null, replay_issued_at: null, replay_grant_token: null,
      agent_id: TEST_AGENT.id, principal_id: 'user_123', developer_id: TEST_DEVELOPER.id, scopes: ['read files'],
      grant_status: 'active', grant_expires_at: new Date(Date.now() + 86400_000).toISOString(),
      agent_did: TEST_AGENT.did, agent_key_thumbprint: null,
    }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'ref_WS' }]);
    sqlMock.mockResolvedValueOnce([]);
    const res = await app.inject({
      method: 'POST', url: '/v1/token/refresh', headers: authHeader(),
      payload: { refreshToken: 'ref_WS', agentId: TEST_AGENT.id },
    });
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)['scp']).toEqual(['read files']);
  });

  it('refuses whitespace in scopes of new authorization requests', async () => {
    seedAuth();
    const res = await app.inject({
      method: 'POST', url: '/v1/authorize', headers: authHeader(),
      payload: { agentId: TEST_AGENT.id, principalId: 'user_123', scopes: ['read files'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('INVALID_SCOPE');
  });

  it('a 0.6 token whose scope and scp disagree is still refused', async () => {
    const { privateKey, kid, alg } = getKeyPair();
    const token = await new SignJWT({ [GRANT_CLAIM]: { agent_did: 'a', developer_id: 'd' }, scp: ['read files'], scope: 'read files' })
      .setProtectedHeader({ alg, kid, typ: 'at+jwt' })
      .setIssuer(config.jwtIssuer).setSubject('u').setJti('t').setIssuedAt().setExpirationTime(exp())
      .sign(privateKey);
    await expect(verifyGrantToken(token)).rejects.toBeInstanceOf(GrantTokenClaimsError);
  });
});

describe('start-up notice', () => {
  it('warns while the legacy claim aliases are issued', () => {
    expect(grantTokenClaimsStartupNotices({ grantTokenLegacyClaims: true })).toEqual([expect.stringContaining('The default becomes false in 0.7')]);
    expect(grantTokenClaimsStartupNotices({ grantTokenLegacyClaims: false })).toEqual([]);
  });
});

describe('RFC 8693 act chains', () => {
  it('nests the delegator ahead of earlier actors and bounds the depth', () => {
    expect(delegatedActorClaim('did:grantex:ag_B', undefined)).toEqual({ sub: 'did:grantex:ag_B' });
    expect(delegatedActorClaim('did:grantex:ag_C', { sub: 'did:grantex:ag_B', act: { sub: 'did:grantex:ag_A' } }))
      .toEqual({ sub: 'did:grantex:ag_C', act: { sub: 'did:grantex:ag_B', act: { sub: 'did:grantex:ag_A' } } });

    let chain: Record<string, unknown> = { sub: 'did:grantex:ag_0' };
    for (let i = 1; i < 10; i += 1) chain = { sub: `did:grantex:ag_${i}`, act: chain };
    expect(() => parseActorClaim(chain)).not.toThrow();
    expect(() => delegatedActorClaim('did:grantex:ag_10', chain)).toThrow(GrantTokenClaimsError);
    expect(() => parseActorClaim({ sub: '' })).toThrow(GrantTokenClaimsError);
  });

  it('delegation issues a nested act chain and stores it on the grant', async () => {
    const parentToken = await signGrantToken({
      sub: 'user_123',
      agt: TEST_AGENT.did,
      dev: TEST_DEVELOPER.id,
      scp: ['tool:acme_kyb:read', 'read'],
      jti: 'tok_PARENT_ACT',
      grnt: 'grnt_PARENT_ACT',
      exp: Math.floor(Date.now() / 1000) + 3600,
      act: { sub: 'did:grantex:ag_ROOT' },
      parentAgt: 'did:grantex:ag_ROOT',
      parentGrnt: 'grnt_ROOT',
      delegationDepth: 1,
      authorizationDetails: [
        { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' },
        { type: 'urn:grantex:decision:v1', connector: 'acme_kyb', tools: ['case_decision'] },
        { type: 'urn:grantex:decision:v1', connector: 'other_kyb', tools: ['case_decision'] },
      ],
    }, { legacyClaims: false });

    seedAuth();
    mockRedis.get.mockResolvedValue(null);
    sqlMock.mockResolvedValueOnce([{ is_revoked: false, expires_at: new Date(Date.now() + 3600_000).toISOString(), grant_status: 'active' }]);
    sqlMock.mockResolvedValueOnce([{ id: 'ag_SUBACT', did: 'did:grantex:ag_SUBACT', scopes: [], key_thumbprint: null }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_PARENT_ACT' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/grants/delegate',
      headers: authHeader(),
      payload: { parentGrantToken: parentToken, subAgentId: 'ag_SUBACT', scopes: ['tool:acme_kyb:read'], expiresIn: '1h' },
    });
    expect(res.statusCode).toBe(201);
    const claims = decodeJwt(res.json<{ grantToken: string }>().grantToken);
    const expectedAct = { sub: TEST_AGENT.did, act: { sub: 'did:grantex:ag_ROOT' } };
    expect(claims['act']).toEqual(expectedAct);
    expect(claims[GRANT_CLAIM]).toMatchObject({ agent_did: 'did:grantex:ag_SUBACT', parent_grant_id: 'grnt_PARENT_ACT', delegation_depth: 2 });
    // The child keeps the decision reference of the connector it keeps.
    expect(claims['authorization_details']).toEqual([
      { type: 'urn:grantex:tools:v1', connector: 'acme_kyb', purpose: 'aml.screening' },
      { type: 'urn:grantex:decision:v1', connector: 'acme_kyb', tools: ['case_decision'] },
    ]);

    const insert = sqlMock.mock.calls.find((call) => (call[0] as TemplateStringsArray).join(' ').includes('INSERT INTO grants'));
    expect(insert).toContainEqual(expectedAct);
  });
});

describe('refreshed delegated tokens keep the stored act chain', () => {
  const refreshRow = {
    refresh_id: 'ref_ACT', grant_id: 'grnt_ACT', is_used: false,
    refresh_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    used_at: null, rotated_to_token_id: null, replay_expires_at: null, replay_request_hash: null,
    replay_jti: null, replay_issued_at: null, replay_grant_token: null,
    agent_id: TEST_AGENT.id, principal_id: 'user_123', developer_id: TEST_DEVELOPER.id, scopes: ['read'],
    grant_status: 'active', grant_expires_at: new Date(Date.now() + 86400_000).toISOString(),
    agent_did: TEST_AGENT.did, agent_key_thumbprint: null,
    parent_grant_id: 'grnt_PARENT', parent_agent_did: 'did:grantex:ag_PARENT', delegation_depth: 2,
  };

  async function refresh(row: Record<string, unknown>) {
    seedAuth();
    sqlMock.mockResolvedValueOnce([row]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'ref_ACT' }]);
    sqlMock.mockResolvedValueOnce([]);
    return app.inject({
      method: 'POST',
      url: '/v1/token/refresh',
      headers: authHeader(),
      payload: { refreshToken: 'ref_ACT', agentId: TEST_AGENT.id },
    });
  }

  it('uses the stored chain', async () => {
    const chain = { sub: 'did:grantex:ag_PARENT', act: { sub: 'did:grantex:ag_ROOT' } };
    const res = await refresh({ ...refreshRow, actor_chain: chain });
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)['act']).toEqual(chain);
  });

  it('falls back to the delegating agent for grants delegated before the chain was stored', async () => {
    const res = await refresh({ ...refreshRow, actor_chain: null });
    expect(res.statusCode).toBe(201);
    expect(decodeJwt(res.json<{ grantToken: string }>().grantToken)['act']).toEqual({ sub: 'did:grantex:ag_PARENT' });
  });

  it('refuses a stored chain that does not start with the delegating agent', async () => {
    const res = await refresh({ ...refreshRow, actor_chain: { sub: 'did:grantex:ag_OTHER' } });
    expect(res.statusCode).toBe(500);
  });
});
