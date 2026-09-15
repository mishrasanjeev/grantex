/**
 * spec/examples/grant-token-0.6.issued.json: grant tokens issued by this
 * service's signGrantToken for the claims of spec/examples/grant-token-0.6.json,
 * with the JWK Set that verifies them. The Python and Go SDK tests validate
 * these tokens with stock JOSE libraries.
 *
 * Regenerate with GRANTEX_WRITE_FIXTURES=1 (new keys each time; the private
 * keys are discarded). Without it, this test checks every committed token
 * against the claims the issuing code produces and against the JWK Set.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { config } from '../src/config.js';
import { initKeys, signGrantToken, type GrantTokenPayload } from '../src/lib/crypto.js';
import { GRANT_CLAIM, buildGrantTokenClaims } from '../src/lib/grant-token-claims.js';
import { loadEnvSigningKeyRing, setLegacyKidPolicy, setSigningKeyRing, thumbprintKid } from '../src/lib/signing-keys.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLE = join(repoRoot, 'spec', 'examples', 'grant-token-0.6.json');
const ISSUED = join(repoRoot, 'spec', 'examples', 'grant-token-0.6.issued.json');
const IAT = Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000);
const EXP = 4_102_444_800; // 2100-01-01

type TokenName = 'standard_rs256' | 'standard_es256' | 'legacy_aliases_es256' | 'whitespace_scope_es256' | 'pre_0_6_whitespace_scope_rs256';

interface IssuedFixture {
  description: string;
  issuer: string;
  audience: string;
  jwks: { keys: JWK[] };
  tokens: Record<TokenName, { alg: string; kid: string; legacy_claims: boolean | null; token: string }>;
}

function inputFromExample(): GrantTokenPayload {
  const example = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as { standard: Record<string, unknown> };
  const s = example.standard as Record<string, any>;
  const grant = s[GRANT_CLAIM];
  return {
    sub: s['sub'], agt: grant.agent_did, dev: grant.developer_id, clientId: s['client_id'],
    scp: String(s['scope']).split(' '), jti: s['jti'], grnt: grant.grant_id, aud: s['aud'],
    iat: IAT, exp: EXP, cnf: s['cnf'], act: s['act'], authorizationDetails: s['authorization_details'],
    parentAgt: s['act'].sub, parentGrnt: grant.parent_grant_id, delegationDepth: grant.delegation_depth,
  };
}

const WHITESPACE_SCOPES = ['tool:acme_kyb:read', 'read case files'];
const PRE_0_6_CLAIMS = {
  agt: 'did:grantex:ag_01UNDERWRITER', dev: 'dev_01EXAMPLE', grnt: 'grnt_01EXAMPLEOLD',
  scp: WHITESPACE_SCOPES, scope: WHITESPACE_SCOPES.join(' '), client_id: 'ag_01UNDERWRITER',
};

function expectedPayload(name: TokenName, issuer: string): Record<string, unknown> {
  const input = inputFromExample();
  if (name === 'pre_0_6_whitespace_scope_rs256') {
    return { ...PRE_0_6_CLAIMS, iss: issuer, sub: input.sub, aud: input.aud, jti: 'tok_01EXAMPLEOLD', iat: IAT, exp: EXP };
  }
  const variant = name === 'whitespace_scope_es256' ? { ...input, scp: WHITESPACE_SCOPES } : input;
  const legacyClaims = name === 'legacy_aliases_es256';
  return {
    ...buildGrantTokenClaims(variant, { legacyClaims }),
    iss: issuer, sub: variant.sub, aud: variant.aud, jti: variant.jti, iat: IAT, exp: EXP,
  };
}

afterAll(async () => {
  (config as unknown as { jwtIssuer: string }).jwtIssuer = 'https://grantex.dev';
  await initKeys();
});

if (process.env['GRANTEX_WRITE_FIXTURES'] === '1') {
  it('writes the issued fixture', async () => {
    const example = JSON.parse(readFileSync(EXAMPLE, 'utf8')) as { standard: Record<string, unknown> };
    const issuer = String(example.standard['iss']);
    (config as unknown as { jwtIssuer: string }).jwtIssuer = issuer;
    setLegacyKidPolicy({ months: 0, transitionSeconds: 0 });
    const rsa = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const ec = await generateKeyPair('ES256', { extractable: true });
    const ring = async (alg: 'RS256' | 'ES256') => loadEnvSigningKeyRing({
      alg, rsaPrivateKey: await exportPKCS8(rsa.privateKey), ecPrivateKey: await exportPKCS8(ec.privateKey),
      autoGenerate: false, verificationPublicKeys: null, legacyKidKey: null,
    });
    const rsRing = await ring('RS256');
    const esRing = await ring('ES256');
    const input = inputFromExample();
    const issue = async (r: typeof rsRing, payload: GrantTokenPayload, legacyClaims: boolean) => {
      setSigningKeyRing(r);
      const token = await signGrantToken(payload, { legacyClaims });
      return { alg: r.active.alg, kid: r.active.kid, legacy_claims: legacyClaims, token };
    };
    setSigningKeyRing(rsRing);
    const preToken = await new SignJWT(PRE_0_6_CLAIMS)
      .setProtectedHeader({ alg: 'RS256', kid: rsRing.active.kid, typ: 'at+jwt' })
      .setIssuer(issuer).setSubject(input.sub).setAudience(input.aud!).setJti('tok_01EXAMPLEOLD')
      .setIssuedAt(IAT).setExpirationTime(EXP)
      .sign(rsa.privateKey);
    const fixture: IssuedFixture = {
      description: 'Grant tokens issued by apps/auth-service signGrantToken for the claims of grant-token-0.6.json (iat 2026-09-01, exp 2100), and the JWK Set that verifies them. pre_0_6_whitespace_scope_rs256 has the pre-0.6 shape, with scope a lossy join of scp. Generated by apps/auth-service/tests/grant-token-issued-fixture.test.ts; the private keys were discarded.',
      issuer,
      audience: String(input.aud),
      jwks: { keys: [{ ...rsRing.active.publicJwk }, { ...esRing.active.publicJwk }] },
      tokens: {
        standard_rs256: await issue(rsRing, input, false),
        standard_es256: await issue(esRing, input, false),
        legacy_aliases_es256: await issue(esRing, input, true),
        whitespace_scope_es256: await issue(esRing, { ...input, scp: WHITESPACE_SCOPES }, false),
        pre_0_6_whitespace_scope_rs256: { alg: 'RS256', kid: rsRing.active.kid, legacy_claims: null, token: preToken },
      },
    };
    writeFileSync(ISSUED, `${JSON.stringify(fixture, null, 2)}\n`);
  });
}

describe('grant-token-0.6.issued fixture', () => {
  let fixture: IssuedFixture;
  beforeAll(() => {
    fixture = JSON.parse(readFileSync(ISSUED, 'utf8')) as IssuedFixture;
  });

  it('publishes each key under its thumbprint kid', async () => {
    for (const key of fixture.jwks.keys) {
      expect(key.kid).toBe(await thumbprintKid(key.alg as 'RS256' | 'ES256', key));
    }
  });

  it('every token is signed by a published key and carries exactly the claims the issuing code produces', async () => {
    const jwks = createLocalJWKSet(fixture.jwks);
    for (const [name, entry] of Object.entries(fixture.tokens) as Array<[TokenName, IssuedFixture['tokens'][TokenName]]>) {
      const { protectedHeader } = await jwtVerify(entry.token, jwks, {
        algorithms: ['RS256', 'ES256'], issuer: fixture.issuer, audience: fixture.audience, typ: 'at+jwt',
      });
      expect([name, protectedHeader.alg, protectedHeader.kid]).toEqual([name, entry.alg, entry.kid]);
      expect(decodeProtectedHeader(entry.token)).toEqual({ alg: entry.alg, kid: entry.kid, typ: 'at+jwt' });
      expect(decodeJwt(entry.token)).toEqual(expectedPayload(name, fixture.issuer));
    }
  });

  it('whitespace-scope tokens carry scp and no scope', () => {
    for (const name of ['whitespace_scope_es256'] as const) {
      const payload = decodeJwt(fixture.tokens[name].token);
      expect(payload).not.toHaveProperty('scope');
      expect(payload['scp']).toEqual(WHITESPACE_SCOPES);
    }
  });
});
