/**
 * Decision grants (PRD G-3): canonicalisation parity, step-up, approver
 * identity, dwell, expiry, tokens and approver ID-token verification, without
 * a database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initKeys, getKeyPair, signGrantToken } from '../src/lib/crypto.js';
import { canonicalize, CanonicalizationError, parseJsonRejectingDuplicates } from '../src/lib/decisions/canonical.js';
import { ActionValidationError, computeActionHash, parseDecisionAction, type DecisionAction } from '../src/lib/decisions/action.js';
import {
  DECISION_MAX_LIFETIME_SECONDS,
  DecisionError,
  approverAuthMethod,
  approverClaimsFromIdToken,
  approverSubject,
  assertStepUp,
  decisionGrantExpiry,
  serverDwellMs,
  type StepUpPolicy,
} from '../src/lib/decisions/policy.js';
import { DecisionTokenError, signDecisionGrant, verifyDecisionGrantSignature } from '../src/lib/decisions/token.js';
import { decisionSettings, DecisionSettingsError } from '../src/lib/decisions/settings.js';
import { clearApproverIdpCaches, discover, verifyIdToken, type ApproverIdp } from '../src/lib/decisions/approver-oidc.js';
import { approverEmailHash } from '../src/lib/decisions/personal-data.js';
import { setSafeFetchForTests } from '../src/lib/url-security.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLES = join(ROOT, 'spec', 'examples');

const STEP_UP: StepUpPolicy = { acrValues: ['urn:example:loa:high'], amrValues: ['mfa', 'hwk'], maxAgeSeconds: 3600, idTokenMaxAgeSeconds: 600 };
const ACTION: DecisionAction = { case_id: 'case_8841', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' };
const HASH = `sha256:${'A'.repeat(43)}`;

beforeAll(async () => {
  await initKeys();
});

describe('canonicalisation copy used by the auth service', () => {
  it('reproduces the RFC 8785 test vectors', () => {
    const vectors = join(EXAMPLES, 'canonicalization', 'rfc8785');
    for (const file of readdirSync(join(vectors, 'input'))) {
      const value: unknown = JSON.parse(readFileSync(join(vectors, 'input', file), 'utf-8'));
      expect(Buffer.from(canonicalize(value), 'utf8').equals(readFileSync(join(vectors, 'output', file)))).toBe(true);
    }
  });

  it('matches the shared parity cases', () => {
    const parity = JSON.parse(readFileSync(join(EXAMPLES, 'canonicalization', 'parity.json'), 'utf-8')) as {
      valid: { input: string; canonical: string }[];
      invalid: { input: string }[];
    };
    for (const c of parity.valid) expect(canonicalize(JSON.parse(c.input))).toBe(c.canonical);
    for (const c of parity.invalid) expect(() => canonicalize(JSON.parse(c.input))).toThrow(CanonicalizationError);
  });

  it('matches the shared action hashes, refusals and duplicate-key cases', () => {
    const fixtures = JSON.parse(readFileSync(join(EXAMPLES, 'decision-grant', 'action-hash.json'), 'utf-8')) as {
      valid: { action: DecisionAction; action_hash: string }[];
      invalid: { action?: unknown; action_json?: string; code: string; field: string }[];
      duplicate_keys: { action_json: string }[];
    };
    for (const c of fixtures.valid) expect(computeActionHash(c.action)).toBe(c.action_hash);
    for (const c of fixtures.invalid) {
      const raw: unknown = c.action_json !== undefined ? JSON.parse(c.action_json) : c.action;
      try {
        parseDecisionAction(raw);
        throw new Error('expected a refusal');
      } catch (err) {
        expect(err).toBeInstanceOf(ActionValidationError);
        expect([(err as ActionValidationError).code, (err as ActionValidationError).field]).toEqual([c.code, c.field]);
      }
    }
    for (const c of fixtures.duplicate_keys) expect(() => parseJsonRejectingDuplicates(c.action_json)).toThrow(CanonicalizationError);
  });

  it('is the same code as the TypeScript SDK (no drift)', () => {
    const strip = (text: string) => text.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '').replace(/\r\n/g, '\n');
    const service = strip(readFileSync(join(ROOT, 'apps', 'auth-service', 'src', 'lib', 'decisions', 'canonical.ts'), 'utf-8'));
    const sdk = strip(readFileSync(join(ROOT, 'packages', 'sdk-ts', 'src', 'canonical.ts'), 'utf-8'));
    expect(service).toBe(sdk);
    const serviceAction = readFileSync(join(ROOT, 'apps', 'auth-service', 'src', 'lib', 'decisions', 'action.ts'), 'utf-8').replace(/\r\n/g, '\n');
    const sdkAction = readFileSync(join(ROOT, 'packages', 'sdk-ts', 'src', 'decisions', 'action.ts'), 'utf-8').replace(/\r\n/g, '\n');
    expect(serviceAction).toBe(sdkAction.replace("from '../canonical.js'", "from './canonical.js'"));
  });
});

describe('step-up authentication and approver identity', () => {
  const now = 1_790_000_000;
  const idToken = (overrides: Record<string, unknown> = {}) => ({ sub: 'idp-user-1', iat: now - 5, auth_time: now - 60, amr: ['pwd', 'hwk'], ...overrides });

  it('accepts an accepted amr value within the window', () => {
    const claims = approverClaimsFromIdToken(idToken(), now, STEP_UP);
    expect(() => assertStepUp(claims, now, STEP_UP)).not.toThrow();
    expect(approverAuthMethod(claims)).toBe('sso+hwk+pwd');
  });

  it('accepts an accepted acr value', () => {
    const claims = approverClaimsFromIdToken(idToken({ amr: undefined, acr: 'urn:example:loa:high' }), now, STEP_UP);
    expect(() => assertStepUp(claims, now, STEP_UP)).not.toThrow();
    expect(approverAuthMethod(claims)).toBe('sso+acr');
  });

  it('refuses a password-only login and a step-up older than the window (step_up_required)', () => {
    expect(() => assertStepUp(approverClaimsFromIdToken(idToken({ amr: ['pwd'] }), now, STEP_UP), now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'step_up_required', status: 403 }));
    expect(() => assertStepUp(approverClaimsFromIdToken(idToken({ auth_time: now - 3601 }), now, STEP_UP), now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'step_up_required' }));
  });

  it('refuses an ID token without auth_time, with a stale or future iat, or with malformed claims', () => {
    expect(() => approverClaimsFromIdToken(idToken({ auth_time: undefined }), now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'step_up_required' }));
    for (const bad of [{ iat: now - 601 }, { iat: now + 3600 }, { auth_time: now + 3600 }, { amr: 'hwk' }, { amr: ['h w k'] }, { sub: '' }, { sub: 'has space' }]) {
      expect(() => approverClaimsFromIdToken(idToken(bad), now, STEP_UP), JSON.stringify(bad)).toThrow(DecisionError);
    }
  });

  it('counts an email only when the identity provider verified it', () => {
    expect(approverClaimsFromIdToken(idToken({ email: 'a@example.com', email_verified: true }), now, STEP_UP).verifiedEmail).toBe('a@example.com');
    expect(approverClaimsFromIdToken(idToken({ email: 'a@example.com' }), now, STEP_UP).verifiedEmail).toBeUndefined();
    expect(approverClaimsFromIdToken(idToken({ email: 'a@example.com', email_verified: 'true' }), now, STEP_UP).verifiedEmail).toBeUndefined();
  });

  it('namespaces the approver subject by issuer', () => {
    const a = approverSubject('https://idp.example.com', 'user-1');
    expect(a).toMatch(/^user:[A-Za-z0-9_-]{22}:user-1$/);
    expect(approverSubject('https://idp-two.example.com', 'user-1')).not.toBe(a);
    expect(approverSubject('https://idp.example.com', 'user-1')).toBe(a);
  });

  it('hashes emails case-insensitively with a key, never storing them', () => {
    expect(approverEmailHash('A@Example.com')).toBe(approverEmailHash('a@example.com'));
    expect(approverEmailHash('a@example.com')).toMatch(/^hmac-sha256:[A-Za-z0-9_-]{43}$/);
    expect(approverEmailHash('a@example.com')).not.toContain('example');
  });
});

describe('dwell time and expiry', () => {
  const policy = { minMs: 2_000, maxMs: 86_400_000 };
  it('measures from rendering to submission and refuses faster approvals', () => {
    expect(serverDwellMs(1_000, 62_250, policy)).toBe(61_250);
    expect(() => serverDwellMs(1_000, 2_999, policy)).toThrow(expect.objectContaining({ subReason: 'dwell_too_short' }));
    expect(serverDwellMs(0, 100_000_000, policy)).toBe(86_400_000);
  });
  it('caps a grant at 24 hours and at the request expiry', () => {
    expect(decisionGrantExpiry(1000, (1000 + 2 * DECISION_MAX_LIFETIME_SECONDS) * 1000)).toBe(1000 + DECISION_MAX_LIFETIME_SECONDS);
    expect(decisionGrantExpiry(1000, 5000 * 1000)).toBe(5000);
  });
});

describe('settings', () => {
  it('uses fail-closed defaults and refuses invalid values', () => {
    const saved = { ...process.env };
    try {
      delete process.env['DECISION_STEP_UP_AMR'];
      delete process.env['DECISION_STEP_UP_ACR'];
      expect(decisionSettings().stepUp.amrValues).toEqual(['mfa', 'hwk']);
      expect(decisionSettings().dwell.minMs).toBe(2000);
      expect(decisionSettings().enabled).toBe(false);
      expect(decisionSettings().publicOrigin).toBe('https://grantex.dev');
      process.env['DECISION_STEP_UP_AMR'] = '';
      expect(() => decisionSettings()).toThrow(DecisionSettingsError);
      process.env['DECISION_STEP_UP_AMR'] = 'mfa';
      process.env['DECISION_STEP_UP_MAX_AGE_SECONDS'] = '99999999';
      expect(() => decisionSettings()).toThrow(DecisionSettingsError);
      process.env['DECISION_STEP_UP_MAX_AGE_SECONDS'] = '600';
      process.env['DECISION_MIN_DWELL_MS'] = '5000';
      process.env['DECISION_MAX_DWELL_MS'] = '1000';
      expect(() => decisionSettings()).toThrow(DecisionSettingsError);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe('decision grant tokens', () => {
  const claims = () => ({
    sub: 'user:ns:idp-user-1',
    jti: 'dgnt_01K00000000000000000000000',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    dev: 'dev_TEST',
    idp: 'https://idp.example.com',
    approver_auth: 'sso+hwk',
    amr: ['hwk'],
    auth_time: Math.floor(Date.now() / 1000) - 60,
    action: ACTION,
    action_hash: computeActionHash(ACTION),
    connector: 'acme_kyb',
    case_version: 'v1',
    dwell_ms: 61_250,
    dwell_source: 'server' as const,
    decision_request: 'dreq_01K00000000000000000000000',
    memo_hash: HASH,
    policy_score_hash: HASH,
  });

  it('signs typ decision+jwt with a kid and the decision audience and round-trips the claims', async () => {
    const token = await signDecisionGrant(claims());
    expect(decodeProtectedHeader(token)).toMatchObject({ typ: 'decision+jwt', alg: 'RS256', kid: getKeyPair().kid });
    expect(decodeJwt(token)).toMatchObject({ aud: 'urn:grantex:decision', dwell_source: 'server', memo_hash: HASH });
    expect((await verifyDecisionGrantSignature(token)).action).toEqual(ACTION);
  });

  it('refuses a tampered token, a grant token, an unknown kid, a missing kid and a wrong audience', async () => {
    const token = await signDecisionGrant(claims());
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    payload['action'] = { ...ACTION, decision: 'decline' };
    await expect(verifyDecisionGrantSignature(`${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`)).rejects.toThrow(DecisionTokenError);

    const grantToken = await signGrantToken({ sub: 'user_1', agt: 'did:grantex:ag_1', dev: 'dev_TEST', scp: ['tool:acme_kyb:write'], jti: 'tok_1', exp: Math.floor(Date.now() / 1000) + 60 });
    await expect(verifyDecisionGrantSignature(grantToken)).rejects.toThrow(/typ/);

    const { privateKey, kid } = getKeyPair();
    const sign = (header: Record<string, unknown>, extra: Record<string, unknown> = {}) => new SignJWT({ ...claims(), aud: 'urn:grantex:decision', ...extra })
      .setProtectedHeader({ alg: 'RS256', typ: 'decision+jwt', ...header })
      .setIssuer('https://grantex.dev')
      .sign(privateKey);
    await expect(verifyDecisionGrantSignature(await sign({ kid: 'another-kid' }))).rejects.toThrow(DecisionTokenError);
    await expect(verifyDecisionGrantSignature(await sign({}))).rejects.toThrow(/kid/);
    await expect(verifyDecisionGrantSignature(await sign({ kid }, { aud: 'urn:other' }))).rejects.toThrow(DecisionTokenError);
    await expect(verifyDecisionGrantSignature(await signDecisionGrant({ ...claims(), dwell_source: 'reported' as 'server' }))).rejects.toThrow(/dwell_source/);
  });
});

describe('approver ID-token verification', () => {
  const issuer = 'https://idp.example.com';
  const idp: ApproverIdp = { id: 'dapi_1', issuer, clientId: 'client-1', acrValues: [] };
  const discovery = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` };
  let keys: { privateKey: CryptoKey; jwk: Record<string, unknown> };
  let published: Record<string, unknown>[] = [];
  let discoveryIssuer = issuer;
  let fetches = 0;

  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    keys = { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256' } };
    published = [keys.jwk];
    setSafeFetchForTests(async (url) => {
      fetches++;
      if (url.endsWith('/.well-known/openid-configuration')) return new Response(JSON.stringify({ ...discovery, issuer: discoveryIssuer }));
      return new Response(JSON.stringify({ keys: published }));
    });
  });

  afterEach(() => {
    clearApproverIdpCaches();
    discoveryIssuer = issuer;
    published = [keys.jwk];
  });

  const token = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = { alg: 'ES256', kid: 'k1' }, key: CryptoKey | Uint8Array = keys.privateKey) =>
    new SignJWT({ nonce: 'n-1', ...claims })
      .setProtectedHeader(header as { alg: string })
      .setIssuer((claims['iss'] as string | undefined) ?? issuer)
      .setAudience((claims['aud'] as string | string[] | undefined) ?? 'client-1')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);

  it('accepts a token for this client with the expected nonce', async () => {
    await expect(verifyIdToken(idp, discovery, await token(), 'n-1')).resolves.toMatchObject({ sub: 'user-1' });
    await expect(verifyIdToken(idp, discovery, await token({ aud: ['client-1', 'other'], azp: 'client-1' }), 'n-1')).resolves.toBeDefined();
  });

  it.each([
    ['wrong nonce', {}, 'n-2'],
    ['wrong issuer', { iss: 'https://idp.attacker.example.com' }, 'n-1'],
    ['wrong audience', { aud: 'other-client' }, 'n-1'],
    ['several audiences without azp', { aud: ['client-1', 'other'] }, 'n-1'],
    ['foreign azp', { azp: 'other-client' }, 'n-1'],
    ['missing nonce', { nonce: undefined }, 'n-1'],
  ])('refuses %s', async (_name, claims, nonce) => {
    await expect(verifyIdToken(idp, discovery, await token(claims), nonce)).rejects.toMatchObject({ subReason: 'authentication_failed' });
  });

  it('refuses an HMAC-signed token', async () => {
    const hmac = await token({}, { alg: 'HS256', kid: 'k1' }, new TextEncoder().encode('x'.repeat(32)));
    await expect(verifyIdToken(idp, discovery, hmac, 'n-1')).rejects.toMatchObject({ subReason: 'authentication_failed' });
  });

  it('refuses discovery whose issuer differs from the configured issuer', async () => {
    discoveryIssuer = 'https://idp.attacker.example.com';
    await expect(discover(issuer)).rejects.toMatchObject({ subReason: 'authentication_failed' });
  });

  it('refetches the key set once for a rotated key id', async () => {
    await verifyIdToken(idp, discovery, await token(), 'n-1');
    const pair = await generateKeyPair('ES256');
    published = [keys.jwk, { ...(await exportJWK(pair.publicKey)), kid: 'k2', alg: 'ES256' }];
    const rotated = await new SignJWT({ nonce: 'n-1' }).setProtectedHeader({ alg: 'ES256', kid: 'k2' }).setIssuer(issuer).setAudience('client-1').setSubject('user-1').setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    // Within the refresh cooldown the cached set is used and the token is refused.
    await expect(verifyIdToken(idp, discovery, rotated, 'n-1')).rejects.toMatchObject({ subReason: 'authentication_failed' });
    clearApproverIdpCaches();
    const before = fetches;
    await expect(verifyIdToken(idp, discovery, rotated, 'n-1')).resolves.toBeDefined();
    expect(fetches).toBe(before + 1);
  });
});
