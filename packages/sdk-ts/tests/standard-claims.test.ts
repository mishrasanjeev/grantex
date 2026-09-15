/**
 * G-8 standard claims: a 0.6 grant token validates with stock `jose` using
 * only standard semantics, and the SDK reads standard claims, legacy aliases
 * behind the compatibility flag, and refuses disagreement.
 *
 * The payload is spec/examples/grant-token-0.6.json, which the auth service's
 * tests issue byte for byte.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  type CryptoKey,
  type JWK,
} from 'jose';
import {
  GRANT_CLAIM,
  LEGACY_CLAIM_ALIASES,
  claimsToVerifiedGrant,
  clearLegacyClaimWarnings,
  clearRemoteJwksCache,
  verifyGrantToken,
} from '../src/verify.js';
import {
  AuthorizationDetailsError,
  DECISION_DETAIL_TYPE,
  parseDecisionReferences,
} from '../src/authorization-details.js';
import { GrantexTokenError } from '../src/errors.js';

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'grant-token-0.6.json'),
  'utf8',
)) as { standard: Record<string, unknown>; legacy_aliases: Record<string, unknown> };

const ISSUER = FIXTURE.standard['iss'] as string;
const AUDIENCE = FIXTURE.standard['aud'] as string;
const JWKS_URI = `${ISSUER}/.well-known/jwks.json`;

interface Signer { alg: 'RS256' | 'ES256'; privateKey: CryptoKey; publicJwk: JWK }
let rsa: Signer;
let ec: Signer;
let dpopJkt: string;

async function signer(alg: 'RS256' | 'ES256'): Promise<Signer> {
  const pair = await generateKeyPair(alg, { extractable: true });
  return { alg, privateKey: pair.privateKey, publicJwk: { ...(await exportJWK(pair.publicKey)), kid: `${alg}-1`, alg, use: 'sig' } };
}

beforeAll(async () => {
  rsa = await signer('RS256');
  ec = await signer('ES256');
  const dpop = await generateKeyPair('ES256', { extractable: true });
  dpopJkt = await calculateJwkThumbprint(await exportJWK(dpop.publicKey), 'sha256');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [rsa.publicJwk, ec.publicJwk] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })));
});

afterEach(() => {
  clearRemoteJwksCache();
  clearLegacyClaimWarnings();
  vi.restoreAllMocks();
});

function claims(extra: Record<string, unknown> = {}, base: Record<string, unknown> = FIXTURE.standard): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { ...base, iat: now, exp: now + 600, cnf: { jkt: dpopJkt }, ...extra };
}

async function sign(payload: Record<string, unknown>, s: Signer = ec, typ = 'at+jwt'): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: s.alg, kid: s.publicJwk.kid!, typ }).sign(s.privateKey);
}

describe('a stock OAuth/JOSE library validates the token using only standard semantics', () => {
  for (const which of ['RS256', 'ES256'] as const) {
    it(`jose jwtVerify accepts the ${which} standard-form token`, async () => {
      const s = which === 'RS256' ? rsa : ec;
      const token = await sign(claims(), s);
      const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet({ keys: [rsa.publicJwk, ec.publicJwk] }), {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['RS256', 'ES256'],
        typ: 'at+jwt',
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id', 'scope'],
      });
      expect(protectedHeader.alg).toBe(which);
      // RFC 9068 / RFC 8693 / RFC 9449 / RFC 9396, read as plain JSON.
      expect((payload['scope'] as string).split(' ')).toContain('tool:acme_kyb:read');
      expect(payload['client_id']).toBe('ag_01UNDERWRITER');
      expect((payload['cnf'] as { jkt: string }).jkt).toBe(dpopJkt);
      expect((payload['act'] as { sub: string }).sub).toBe('did:grantex:ag_01ORCHESTRATOR');
      expect(payload['authorization_details']).toEqual(FIXTURE.standard['authorization_details']);
    });
  }
});

describe('verifyGrantToken reads the standard form', () => {
  it('maps every standard claim with legacyClaims: false and emits no warning', async () => {
    const warn = vi.spyOn(process, 'emitWarning');
    const grant = await verifyGrantToken(await sign(claims()), { jwksUri: JWKS_URI, audience: AUDIENCE, legacyClaims: false });
    expect(grant).toMatchObject({
      tokenId: 'tok_01EXAMPLETOKEN',
      grantId: 'grnt_01EXAMPLECHILD',
      principalId: 'user_01EXAMPLEPRINCIPAL',
      agentDid: 'did:grantex:ag_01UNDERWRITER',
      developerId: 'dev_01EXAMPLE',
      clientId: 'ag_01UNDERWRITER',
      scopes: ['tool:acme_kyb:read', 'tool:acme_kyb:write'],
      parentAgentDid: 'did:grantex:ag_01ORCHESTRATOR',
      parentGrantId: 'grnt_01EXAMPLEPARENT',
      delegationDepth: 2,
      act: FIXTURE.standard['act'],
      cnf: { jkt: dpopJkt },
      audience: AUDIENCE,
    });
    expect(grant.legacyClaimsUsed).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a 0.6 token carrying both forms without a warning', async () => {
    const warn = vi.spyOn(process, 'emitWarning');
    const grant = await verifyGrantToken(await sign(claims(FIXTURE.legacy_aliases)), { jwksUri: JWKS_URI });
    expect(grant.agentDid).toBe('did:grantex:ag_01UNDERWRITER');
    expect(grant.legacyClaimsUsed).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('with legacyClaims: false refuses a token that only has legacy claims', async () => {
    const legacyOnly = claims(FIXTURE.legacy_aliases, {
      iss: ISSUER, sub: 'user_01EXAMPLEPRINCIPAL', jti: 'tok_old',
    });
    await expect(verifyGrantToken(await sign(legacyOnly), { jwksUri: JWKS_URI, legacyClaims: false }))
      .rejects.toThrow(`missing required claims (jti, sub, iat, exp, scope, ${GRANT_CLAIM}.agent_did`);
  });

  it('with legacyClaims: false requires typ at+jwt', async () => {
    await expect(verifyGrantToken(await sign(claims(), ec, 'JWT'), { jwksUri: JWKS_URI, legacyClaims: false }))
      .rejects.toThrow(GrantexTokenError);
  });
});

describe('legacy claim aliases behind the compatibility flag', () => {
  const legacyOnly = () => claims(FIXTURE.legacy_aliases, {
    iss: ISSUER, sub: 'user_01EXAMPLEPRINCIPAL', jti: 'tok_old',
    act: { sub: 'did:grantex:ag_01ORCHESTRATOR' },
  });

  it('reads a pre-0.6 token by default and warns once per alias', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const token = await sign(legacyOnly());
    const grant = await verifyGrantToken(token, { jwksUri: JWKS_URI });
    expect(grant).toMatchObject({
      agentDid: 'did:grantex:ag_01UNDERWRITER', developerId: 'dev_01EXAMPLE', grantId: 'grnt_01EXAMPLECHILD',
      scopes: ['tool:acme_kyb:read', 'tool:acme_kyb:write'], parentGrantId: 'grnt_01EXAMPLEPARENT', delegationDepth: 2,
      parentAgentDid: 'did:grantex:ag_01ORCHESTRATOR',
    });
    expect(grant.legacyClaimsUsed).toEqual(['scp', 'agt', 'dev', 'grnt', 'parentGrnt', 'delegationDepth']);
    expect(warn).toHaveBeenCalledTimes(6);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"scp" is a legacy alias of scope'),
      { type: 'DeprecationWarning', code: 'GRANTEX_LEGACY_CLAIM' },
    );

    await verifyGrantToken(token, { jwksUri: JWKS_URI });
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('names every legacy alias', () => {
    expect(Object.keys(LEGACY_CLAIM_ALIASES).sort()).toEqual(
      ['agt', 'delegationDepth', 'dev', 'grnt', 'parentAgt', 'parentGrnt', 'scp'],
    );
    for (const alias of Object.keys(FIXTURE.legacy_aliases)) expect(LEGACY_CLAIM_ALIASES).toHaveProperty(alias);
  });

  it.each([
    ['scope and scp', { scp: ['tool:acme_kyb:read'] }],
    ['agent_did and agt', { agt: 'did:grantex:ag_OTHER' }],
    ['developer_id and dev', { dev: 'dev_OTHER' }],
    ['grant_id and grnt', { grnt: 'grnt_OTHER' }],
    ['act.sub and parentAgt', { parentAgt: 'did:grantex:ag_OTHER' }],
    ['parent_grant_id and parentGrnt', { parentGrnt: 'grnt_OTHER' }],
    ['delegation_depth and delegationDepth', { delegationDepth: 1 }],
  ])('refuses a token whose %s disagree', async (_name, alias) => {
    await expect(verifyGrantToken(await sign(claims(alias)), { jwksUri: JWKS_URI }))
      .rejects.toThrow(/disagrees with its legacy alias/);
  });

  it('refuses malformed standard claims', () => {
    const base = claims();
    expect(() => claimsToVerifiedGrant({ ...base, scope: ['a'] })).toThrow('scope must be a space-delimited string');
    expect(() => claimsToVerifiedGrant({ ...base, [GRANT_CLAIM]: 'grnt' })).toThrow(`${GRANT_CLAIM} must be an object`);
    expect(() => claimsToVerifiedGrant({ ...base, act: { iss: 'x' } })).toThrow('act claim must be an object');
    let chain: Record<string, unknown> = { sub: 'did:grantex:ag_0' };
    for (let i = 1; i <= 10; i += 1) chain = { sub: `did:grantex:ag_${i}`, act: chain };
    expect(() => claimsToVerifiedGrant({ ...base, act: chain })).toThrow('act chain is deeper than 10');
    expect(() => claimsToVerifiedGrant({ ...base, cnf: 'jkt' })).toThrow('cnf must be an object');
  });
});

describe('decision references in authorization_details', () => {
  it('parses the profile example', () => {
    const refs = parseDecisionReferences(FIXTURE.standard['authorization_details']);
    expect(refs.get('acme_kyb')).toEqual({ connector: 'acme_kyb', tools: ['case_decision'], fourEyesOn: { case_decision: ['decline'] } });
  });

  it.each([
    ['an unknown key', { tools: ['case_decision'], approver: 'x' }],
    ['no tools', { tools: [] }],
    ['a tool that is not a name', { tools: ['case decision'] }],
    ['four_eyes_on for a tool not listed', { tools: ['case_decision'], four_eyes_on: { monitor_delete: ['decline'] } }],
    ['an empty four_eyes_on list', { tools: ['case_decision'], four_eyes_on: { case_decision: [] } }],
  ])('refuses %s', (_name, entry) => {
    expect(() => parseDecisionReferences([{ type: DECISION_DETAIL_TYPE, connector: 'acme_kyb', ...entry }]))
      .toThrow(AuthorizationDetailsError);
  });

  it('refuses two entries for one connector', () => {
    const entry = { type: DECISION_DETAIL_TYPE, connector: 'acme_kyb', tools: ['case_decision'] };
    expect(() => parseDecisionReferences([entry, entry])).toThrow(/repeats connector/);
  });
});
