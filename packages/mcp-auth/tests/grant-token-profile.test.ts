// SPDX-License-Identifier: Apache-2.0
/**
 * The resource guard and the introspection/revocation verifier against the
 * grant token profile (spec/grant-token-0.6.md, "Validation"): RS256 and
 * ES256 only, `typ: at+jwt`, the standard space-delimited `scope`, and the
 * grant record fields under `urn:grantex:grant`, with the legacy aliases
 * (`scp`, `agt`, `dev`, `grnt`, `delegationDepth`) read only as a fallback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import * as jose from 'jose';
import { createMcpResourceGuard } from '../src/resource/guard.js';
import type { GuardRequest, GuardResult, McpResourceGuardOptions } from '../src/resource/guard.js';
import { toolPolicyFromManifests } from '../src/resource/tool-policy.js';
import { requireMcpAuth } from '../src/middleware/express.js';
import { requireMcpAuth as requireMcpAuthHono } from '../src/middleware/hono.js';
import { ALLOWED_ALGORITHMS, createGrantexTokenVerifier } from '../src/lib/verify.js';
import type { McpAuthConfig } from '../src/types.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const GRANT_CLAIM = 'urn:grantex:grant';

type Alg = 'RS256' | 'ES256' | 'PS256' | 'EdDSA';
const keys = new Map<Alg, jose.CryptoKey>();
let jwks: Server;
let issuer: string;

beforeAll(async () => {
  const published: jose.JWK[] = [];
  // The JWK Set publishes a key for every algorithm, labelled with it, so a
  // PS256 or EdDSA token is refused for its algorithm and not for want of a key.
  for (const alg of ['RS256', 'ES256', 'PS256', 'EdDSA'] as const) {
    const pair = await jose.generateKeyPair(alg, { extractable: true });
    keys.set(alg, pair.privateKey);
    published.push({ ...(await jose.exportJWK(pair.publicKey)), kid: `k-${alg}`, alg, use: 'sig' });
  }
  jwks = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  const address = jwks.address();
  issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
});

/** A 0.6 grant token as the auth service issues it with legacy claims off. */
const STANDARD = {
  client_id: 'shopper-01',
  scope: 'tool:acme_kyb:read tool:acme_kyb:write',
  [GRANT_CLAIM]: {
    grant_id: 'grnt_01STANDARD',
    agent_did: 'did:grantex:shopper-01',
    developer_id: 'dev_01EXAMPLE',
    parent_grant_id: 'grnt_01PARENT',
    delegation_depth: 1,
  },
};

/** A pre-0.6 grant token: legacy claims only, no `typ`. */
const LEGACY = {
  scp: ['tool:acme_kyb:read'],
  agt: 'did:grantex:legacy-agent',
  dev: 'dev_01LEGACY',
  grnt: 'grnt_01LEGACY',
  delegationDepth: 0,
};

async function sign(
  claims: Record<string, unknown>,
  options: { alg?: Alg; typ?: string | null } = {},
): Promise<string> {
  const alg = options.alg ?? 'ES256';
  const typ = options.typ === undefined ? 'at+jwt' : options.typ;
  return new jose.SignJWT({ aud: RESOURCE, sub: 'user_01EXAMPLE', ...claims })
    .setProtectedHeader({ alg, kid: `k-${alg}`, ...(typ !== null ? { typ } : {}) })
    .setIssuer(issuer)
    .setJti('tok_01PROFILE')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.get(alg)!);
}

function guardFor(extra: Partial<McpResourceGuardOptions> = {}) {
  return createMcpResourceGuard({ issuer, audience: RESOURCE, warn: () => {}, revocations: 'none', ...extra });
}

async function present(
  token: string,
  extra: Partial<McpResourceGuardOptions> = {},
  body?: unknown,
): Promise<GuardResult> {
  const authorization = `Bearer ${token}`;
  const request: GuardRequest = {
    header: (name) => (name === 'authorization' ? authorization : undefined),
    method: body === undefined ? 'GET' : 'POST',
    bodyParsed: body !== undefined,
    ...(body !== undefined ? { body } : {}),
  };
  return guardFor(extra)(request);
}

function expectInvalidToken(result: GuardResult): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(401);
    expect(result.reason).toBe('invalid_token');
    expect(result.headers['www-authenticate']).toContain('error="invalid_token"');
  }
}

function grantOf(result: GuardResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.body)}`);
  return result.grant;
}

describe('grant token algorithms: RS256 and ES256 only', () => {
  it('accepts RS256 and ES256 grant tokens', async () => {
    for (const alg of ['RS256', 'ES256'] as const) {
      expect((await present(await sign(STANDARD, { alg }))).ok).toBe(true);
      expect((await present(await sign(LEGACY, { alg, typ: null }))).ok).toBe(true);
    }
  });

  it('refuses PS256 and EdDSA tokens even though the JWK Set publishes a matching key', async () => {
    for (const alg of ['PS256', 'EdDSA'] as const) {
      expectInvalidToken(await present(await sign(LEGACY, { alg, typ: null })));
      expectInvalidToken(await present(await sign(STANDARD, { alg })));
    }
  });

  it('refuses a start-up algorithms list with anything outside RS256 and ES256', () => {
    for (const algorithms of [['RS256', 'PS256'], ['EdDSA'], ['ES256', 'HS256'], ['none'], []]) {
      expect(() => guardFor({ algorithms })).toThrow(/`algorithms`/);
      expect(() => requireMcpAuth({ issuer, audience: RESOURCE, warn: () => {}, revocations: 'none', algorithms })).toThrow(/`algorithms`/);
      expect(() => requireMcpAuthHono({ issuer, audience: RESOURCE, warn: () => {}, revocations: 'none', algorithms })).toThrow(/`algorithms`/);
    }
    expect(() => guardFor({ algorithms: ['RS256', 'PS256'] })).toThrow(/PS256/);
  });

  it('names the guard, not a middleware the caller may not have used, in the start-up error', () => {
    expect(() => guardFor({ algorithms: ['PS256'] })).toThrow(/^mcp-auth resource guard: `algorithms` may list only RS256 and ES256/);
    expect(() => requireMcpAuth({ issuer, audience: RESOURCE, warn: () => {}, revocations: 'none', algorithms: ['PS256'] }))
      .toThrow(/^mcp-auth resource guard: /);
  });

  it('narrows to a caller-supplied subset of RS256 and ES256', async () => {
    const extra = { algorithms: ['ES256'] };
    expect((await present(await sign(STANDARD, { alg: 'ES256' }), extra)).ok).toBe(true);
    expectInvalidToken(await present(await sign(STANDARD, { alg: 'RS256' }), extra));
  });

  it('the introspection and revocation verifier accepts only RS256 and ES256', async () => {
    expect(ALLOWED_ALGORITHMS).toEqual(['RS256', 'ES256']);
    const verifier = createGrantexTokenVerifier({ grantexIssuer: issuer, audience: RESOURCE } as McpAuthConfig);
    for (const alg of ['RS256', 'ES256'] as const) {
      await expect(verifier.verify(await sign(LEGACY, { alg, typ: null }))).resolves.toMatchObject({ jti: 'tok_01PROFILE' });
    }
    for (const alg of ['PS256', 'EdDSA'] as const) {
      await expect(verifier.verify(await sign(LEGACY, { alg, typ: null }))).rejects.toThrow();
    }
  });
});

describe('grant token typ', () => {
  it('refuses a token whose typ is not at+jwt', async () => {
    for (const typ of ['decision+jwt', 'JWT', 'wallet-auth+jwt', 'at+jwt+x']) {
      expectInvalidToken(await present(await sign(LEGACY, { typ })));
      expectInvalidToken(await present(await sign(STANDARD, { typ })));
    }
  });

  it('requires typ on every token that is not a pre-0.6 token', async () => {
    // A 0.6 token (urn:grantex:grant) and an RFC 9068 access token without
    // it: the auth service has set typ on both since before either existed.
    expectInvalidToken(await present(await sign({ ...STANDARD, scp: ['tool:acme_kyb:read', 'tool:acme_kyb:write'] }, { typ: null })));
    expectInvalidToken(await present(await sign(STANDARD, { typ: null })));
    expectInvalidToken(await present(await sign({ client_id: 'shopper-01', scope: 'files:read' }, { typ: null })));
  });

  it('accepts at+jwt and application/at+jwt (RFC 9068 §4)', async () => {
    for (const typ of ['at+jwt', 'application/at+jwt', 'AT+JWT']) {
      expect((await present(await sign(STANDARD, { typ }))).ok).toBe(true);
    }
  });

  it('still accepts a pre-0.6 token, which has no typ', async () => {
    expect((await present(await sign(LEGACY, { typ: null }))).ok).toBe(true);
    expect((await present(await sign({ ...LEGACY, scope: 'tool:acme_kyb:read' }, { typ: null }))).ok).toBe(true);
  });

  it('the introspection and revocation verifier applies the same typ rule', async () => {
    const verifier = createGrantexTokenVerifier({ grantexIssuer: issuer, audience: RESOURCE } as McpAuthConfig);
    await expect(verifier.verify(await sign(LEGACY, { typ: 'decision+jwt' }))).rejects.toThrow(/typ/);
    await expect(verifier.verify(await sign({ ...STANDARD, scp: ['tool:acme_kyb:read', 'tool:acme_kyb:write'] }, { typ: null })))
      .rejects.toThrow(/typ/);
    await expect(verifier.verify(await sign(STANDARD))).resolves.toMatchObject({ client_id: 'shopper-01' });
    await expect(verifier.verify(await sign(LEGACY, { typ: null }))).resolves.toMatchObject({ grnt: 'grnt_01LEGACY' });
  });
});

describe('scope: the standard claim first, scp as the fallback', () => {
  const tools = toolPolicyFromManifests([{
    connector: 'acme_kyb',
    tools: { resolve_business: 'read', monitor_enroll: 'write', purge_case: 'delete' },
  }]);
  const call = (name: string) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

  it('reads the space-delimited scope of a token without scp', async () => {
    const token = await sign(STANDARD);
    expect(grantOf(await present(token)).scopes).toEqual(['tool:acme_kyb:read', 'tool:acme_kyb:write']);
    expect((await present(token, { scopes: ['tool:acme_kyb:write'] })).ok).toBe(true);
    expect((await present(token, { tools }, call('monitor_enroll'))).ok).toBe(true);
    const refused = await present(token, { tools }, call('purge_case'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('tool_not_granted');
  });

  it('refuses an access token that is not a grant token: neither urn:grantex:grant nor scp', async () => {
    // The auth service's OAuth profile issues at+jwt access tokens with
    // client_id, scope and a mandatory cnf.jkt, and no grant record. The
    // guard does not verify proof of possession, so admitting one would
    // replay a sender-constrained token as a bearer token. Every grant token
    // carries urn:grantex:grant (0.6) or scp (before 0.6).
    const cnf = { jkt: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs' };
    expectInvalidToken(await present(await sign({ client_id: 'shopper-01', scope: 'tool:acme_kyb:read', cnf })));
    expectInvalidToken(await present(await sign({ client_id: 'shopper-01', scope: 'files:read' })));
    expectInvalidToken(await present(await sign({ scope: 'tool:acme_kyb:read', agt: 'did:grantex:legacy-agent', dev: 'dev_01LEGACY' })));
    const refused = await present(await sign({ client_id: 'shopper-01', scope: 'tool:acme_kyb:read', cnf }));
    if (!refused.ok) expect(refused.body['error_description']).toMatch(/urn:grantex:grant.*scp/);
  });

  it('reads an empty scope as an empty scope set, which the scopes and tools options deny', async () => {
    // As the SDK verifiers and the auth service read it, and as `scp: []`
    // was read before: a grant token with no scopes is still a grant token.
    const token = await sign({ ...STANDARD, scope: '' });
    expect(grantOf(await present(token)).scopes).toEqual([]);
    const missing = await present(token, { scopes: ['tool:acme_kyb:read'] });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('insufficient_scope');
    const ungranted = await present(token, { tools }, call('resolve_business'));
    expect(ungranted.ok).toBe(false);
    if (!ungranted.ok) expect(ungranted.reason).toBe('tool_not_granted');
  });

  it('falls back to scp when a 0.6 token omits scope (a granted scope contains whitespace)', async () => {
    const { scope: _omitted, ...withoutScope } = STANDARD;
    const token = await sign({ ...withoutScope, scp: ['legacy scope'] });
    expect(grantOf(await present(token)).scopes).toEqual(['legacy scope']);
  });

  it('reads a pre-0.6 token from scp, never from its lossy scope', async () => {
    // Before 0.6, scope was scp joined with spaces, so a scope containing a
    // space would split into scopes the grant never had.
    const token = await sign({ ...LEGACY, scp: ['files read'], scope: 'files read' }, { typ: null });
    expect(grantOf(await present(token)).scopes).toEqual(['files read']);
    const refused = await present(token, { scopes: ['files'] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('insufficient_scope');
  });

  it('refuses a 0.6 token whose scope and scp disagree', async () => {
    expectInvalidToken(await present(await sign({ ...STANDARD, scp: ['tool:acme_kyb:read', 'tool:acme_kyb:admin'] })));
    expect(grantOf(await present(await sign({ ...STANDARD, scp: ['tool:acme_kyb:read', 'tool:acme_kyb:write'] }))).scopes)
      .toEqual(['tool:acme_kyb:read', 'tool:acme_kyb:write']);
  });

  it('denies a token from which neither claim yields scopes', async () => {
    const { scope: _omitted, ...withoutScope } = STANDARD;
    for (const claims of [
      withoutScope,
      { ...STANDARD, scope: ['tool:acme_kyb:read'] },
      { ...STANDARD, scope: null },
      { ...STANDARD, scp: null },
      { ...withoutScope, scp: 'tool:acme_kyb:read' },
      { ...withoutScope, scp: ['tool:acme_kyb:read', 7] },
    ]) {
      expectInvalidToken(await present(await sign(claims)));
    }
    expectInvalidToken(await present(await sign({ agt: 'did:grantex:legacy-agent' }, { typ: null })));
  });
});

describe('grant record fields: urn:grantex:grant first, then the legacy aliases', () => {
  it('fills agent, developer, grant and delegation depth from urn:grantex:grant alone', async () => {
    const grant = grantOf(await present(await sign(STANDARD)));
    expect(grant).toMatchObject({
      agentDid: 'did:grantex:shopper-01',
      developerId: 'dev_01EXAMPLE',
      grantId: 'grnt_01STANDARD',
      delegationDepth: 1,
      sub: 'user_01EXAMPLE',
      jti: 'tok_01PROFILE',
    });
  });

  it('still fills them from the aliases of a pre-0.6 token', async () => {
    const grant = grantOf(await present(await sign(LEGACY, { typ: null })));
    expect(grant).toMatchObject({
      scopes: ['tool:acme_kyb:read'],
      agentDid: 'did:grantex:legacy-agent',
      developerId: 'dev_01LEGACY',
      grantId: 'grnt_01LEGACY',
      delegationDepth: 0,
    });
  });

  it('accepts a 0.6 token whose aliases agree, and refuses one whose aliases disagree', async () => {
    const agreeing = {
      ...STANDARD,
      scp: ['tool:acme_kyb:read', 'tool:acme_kyb:write'],
      agt: 'did:grantex:shopper-01',
      dev: 'dev_01EXAMPLE',
      grnt: 'grnt_01STANDARD',
      delegationDepth: 1,
    };
    expect(grantOf(await present(await sign(agreeing)))).toMatchObject({ agentDid: 'did:grantex:shopper-01', delegationDepth: 1 });
    for (const disagreeing of [
      { agt: 'did:grantex:other-agent' },
      { dev: 'dev_01OTHER' },
      { grnt: 'grnt_01OTHER' },
      { delegationDepth: 0 },
    ]) {
      expectInvalidToken(await present(await sign({ ...agreeing, ...disagreeing })));
    }
  });

  it('refuses a legacy alias that is null or mistyped, as the SDK verifiers do', async () => {
    // spec/grant-token-0.6.md, "Null and mistyped claims": a present claim is
    // never treated as absent. The auth service has never issued one, so no
    // grant token it signed is affected.
    for (const alias of [
      { agt: null },
      { agt: 42 },
      { dev: null },
      { dev: '' },
      { grnt: null },
      { grnt: ['grnt_01LEGACY'] },
      { delegationDepth: null },
      { delegationDepth: '1' },
      { delegationDepth: -1 },
      { delegationDepth: 1.5 },
    ]) {
      // Beside the standard claim, where it used to be skipped unread ...
      expectInvalidToken(await present(await sign({ ...STANDARD, ...alias })));
      // ... and where it is the only form.
      expectInvalidToken(await present(await sign({ ...LEGACY, ...alias }, { typ: null })));
    }
  });

  it('refuses a 0.6 token with no agent or developer in either form, as the SDK verifiers do', async () => {
    const { developer_id: _developer, ...noDeveloper } = STANDARD[GRANT_CLAIM];
    const { agent_did: _agent, ...noAgent } = STANDARD[GRANT_CLAIM];
    expectInvalidToken(await present(await sign({ ...STANDARD, [GRANT_CLAIM]: noDeveloper })));
    expectInvalidToken(await present(await sign({ ...STANDARD, [GRANT_CLAIM]: noAgent })));
    expectInvalidToken(await present(await sign({ ...STANDARD, [GRANT_CLAIM]: {} })));
    // The legacy alias stands in for an absent member.
    const withAlias = await present(await sign({ ...STANDARD, [GRANT_CLAIM]: noDeveloper, dev: 'dev_01EXAMPLE' }));
    expect(grantOf(withAlias).developerId).toBe('dev_01EXAMPLE');
  });

  it('refuses a malformed urn:grantex:grant', async () => {
    const scp = ['tool:acme_kyb:read', 'tool:acme_kyb:write'];
    const member = (patch: Record<string, unknown>) => ({ ...STANDARD, scp, [GRANT_CLAIM]: { ...STANDARD[GRANT_CLAIM], ...patch } });
    for (const claims of [
      { ...STANDARD, scp, [GRANT_CLAIM]: 'grnt_01STANDARD' },
      { ...STANDARD, scp, [GRANT_CLAIM]: null },
      { ...STANDARD, scp, [GRANT_CLAIM]: ['grnt_01STANDARD'] },
      member({ developer_id: null }),
      member({ developer_id: '' }),
      member({ agent_did: 42 }),
      member({ grant_id: null }),
      member({ delegation_depth: -1 }),
      member({ delegation_depth: 1.5 }),
      member({ delegation_depth: '1' }),
    ]) {
      expectInvalidToken(await present(await sign(claims)));
    }
  });
});

describe('tokens issued by the auth service (spec/examples/grant-token-0.6.issued.json)', () => {
  // signGrantToken output for every claim shape: standard claims only, with
  // the legacy aliases, a grant with a whitespace scope, and a pre-0.6 token.
  const fixture = JSON.parse(readFileSync(new URL('../../../spec/examples/grant-token-0.6.issued.json', import.meta.url), 'utf8')) as {
    issuer: string;
    audience: string;
    jwks: { keys: jose.JWK[] };
    tokens: Record<string, { token: string }>;
  };
  let fixtureJwks: Server;
  let jwksUri: string;

  beforeAll(async () => {
    fixtureJwks = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fixture.jwks));
    });
    await new Promise<void>((resolve) => fixtureJwks.listen(0, '127.0.0.1', resolve));
    const address = fixtureJwks.address();
    jwksUri = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/.well-known/jwks.json`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => fixtureJwks.close(() => resolve()));
  });

  async function issued(name: string) {
    const guard = createMcpResourceGuard({ issuer: fixture.issuer, jwksUri, audience: fixture.audience, warn: () => {}, revocations: 'none' });
    const authorization = `Bearer ${fixture.tokens[name]!.token}`;
    return grantOf(await guard({ header: (h) => (h === 'authorization' ? authorization : undefined), method: 'GET', bodyParsed: false }));
  }

  const record = {
    agentDid: 'did:grantex:ag_01UNDERWRITER',
    developerId: 'dev_01EXAMPLE',
    grantId: 'grnt_01EXAMPLECHILD',
    delegationDepth: 2,
  };

  it('reads standard-only tokens (legacy claims off) in RS256 and ES256', async () => {
    for (const name of ['standard_rs256', 'standard_es256']) {
      expect(await issued(name)).toMatchObject({ scopes: ['tool:acme_kyb:read', 'tool:acme_kyb:write'], ...record });
    }
  });

  it('reads a token carrying the legacy aliases the same way', async () => {
    expect(await issued('legacy_aliases_es256')).toMatchObject({ scopes: ['tool:acme_kyb:read', 'tool:acme_kyb:write'], ...record });
  });

  it('reads a whitespace-scope grant from scp', async () => {
    expect(await issued('whitespace_scope_es256')).toMatchObject({ scopes: ['tool:acme_kyb:read', 'read case files'], ...record });
  });

  it('reads a pre-0.6 token from scp and the aliases', async () => {
    const grant = await issued('pre_0_6_whitespace_scope_rs256');
    expect(grant).toMatchObject({
      scopes: ['tool:acme_kyb:read', 'read case files'],
      agentDid: 'did:grantex:ag_01UNDERWRITER',
      developerId: 'dev_01EXAMPLE',
      grantId: 'grnt_01EXAMPLEOLD',
    });
    expect(grant.delegationDepth).toBeUndefined();
  });
});
