/**
 * Decision grants (PRD G-3): canonicalisation parity, step-up, dwell, expiry
 * and token rules that need no database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { initKeys, getKeyPair, signGrantToken } from '../src/lib/crypto.js';
import { canonicalize, CanonicalizationError } from '../src/lib/decisions/canonical.js';
import { ActionValidationError, computeActionHash, parseDecisionAction, type DecisionAction } from '../src/lib/decisions/action.js';
import {
  DECISION_MAX_LIFETIME_SECONDS,
  DecisionError,
  approverAuthMethod,
  approverClaimsFromIdToken,
  assertStepUp,
  decisionGrantExpiry,
  validateDwellMs,
  type StepUpPolicy,
} from '../src/lib/decisions/policy.js';
import {
  DECISION_GRANT_AUDIENCE,
  DecisionTokenError,
  signApproverSession,
  signDecisionGrant,
  verifyApproverSession,
  verifyDecisionGrantSignature,
} from '../src/lib/decisions/token.js';
import { decisionSettings, DecisionSettingsError } from '../src/lib/decisions/settings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLES = join(ROOT, 'spec', 'examples');

const STEP_UP: StepUpPolicy = { acrValues: ['urn:example:loa:high'], amrValues: ['mfa', 'hwk'], maxAgeSeconds: 3600, idTokenMaxAgeSeconds: 600 };
const ACTION: DecisionAction = { case_id: 'case_8841', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' };

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

  it('matches the shared action hashes and refusals', () => {
    const fixtures = JSON.parse(readFileSync(join(EXAMPLES, 'decision-grant', 'action-hash.json'), 'utf-8')) as {
      valid: { action: DecisionAction; action_hash: string }[];
      invalid: { action?: unknown; action_json?: string; code: string; field: string }[];
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
  });

  it('is the same code as the TypeScript SDK (no drift)', () => {
    const strip = (text: string) => text.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '').replace(/\r\n/g, '\n');
    const service = strip(readFileSync(join(ROOT, 'apps', 'auth-service', 'src', 'lib', 'decisions', 'canonical.ts'), 'utf-8'));
    const sdk = strip(readFileSync(join(ROOT, 'packages', 'sdk-ts', 'src', 'canonical.ts'), 'utf-8'));
    expect(service).toBe(sdk);
    const serviceAction = strip(readFileSync(join(ROOT, 'apps', 'auth-service', 'src', 'lib', 'decisions', 'action.ts'), 'utf-8'));
    const sdkAction = strip(readFileSync(join(ROOT, 'packages', 'sdk-ts', 'src', 'decisions', 'action.ts'), 'utf-8'));
    expect(serviceAction).toBe(sdkAction.replace("from '../canonical.js'", "from './canonical.js'"));
  });
});

describe('step-up authentication', () => {
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

  it('refuses a password-only login (step_up_required)', () => {
    const claims = approverClaimsFromIdToken(idToken({ amr: ['pwd'] }), now, STEP_UP);
    expect(() => assertStepUp(claims, now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'step_up_required', status: 403 }));
  });

  it('refuses a step-up older than the window (step_up_required)', () => {
    const claims = approverClaimsFromIdToken(idToken({ auth_time: now - 3601 }), now, STEP_UP);
    expect(() => assertStepUp(claims, now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'step_up_required' }));
  });

  it('refuses an ID token without auth_time, with a stale iat, or with malformed claims', () => {
    expect(() => approverClaimsFromIdToken(idToken({ auth_time: undefined }), now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'step_up_required' }));
    expect(() => approverClaimsFromIdToken(idToken({ iat: now - 601 }), now, STEP_UP)).toThrow(expect.objectContaining({ subReason: 'expired' }));
    expect(() => approverClaimsFromIdToken(idToken({ auth_time: now + 3600 }), now, STEP_UP)).toThrow(DecisionError);
    expect(() => approverClaimsFromIdToken(idToken({ amr: 'hwk' }), now, STEP_UP)).toThrow(DecisionError);
    expect(() => approverClaimsFromIdToken(idToken({ amr: ['h w k'] }), now, STEP_UP)).toThrow(DecisionError);
    expect(() => approverClaimsFromIdToken(idToken({ sub: '' }), now, STEP_UP)).toThrow(DecisionError);
    expect(() => approverClaimsFromIdToken(idToken({ sub: 'has space' }), now, STEP_UP)).toThrow(DecisionError);
  });
});

describe('dwell time and expiry', () => {
  const policy = { minMs: 0, maxMs: 86_400_000 };
  it('accepts an integer within bounds and the request age', () => {
    expect(validateDwellMs(61_250, 0, 120_000, policy)).toBe(61_250);
  });
  it.each([[-1], [1.5], ['61250'], [null], [86_400_001]])('refuses %s', (value) => {
    expect(() => validateDwellMs(value, 0, 90_000_000, policy)).toThrow(DecisionError);
  });
  it('refuses a dwell longer than the request has existed', () => {
    expect(() => validateDwellMs(60_000, 10_000, 30_000, policy)).toThrow(/longer than the decision request/);
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
      expect(decisionSettings().enabled).toBe(false);
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
    sub: 'user:idp-user-1',
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
    decision_request: 'dreq_01K00000000000000000000000',
  });

  it('signs typ decision+jwt with the decision audience and round-trips the claims', async () => {
    const token = await signDecisionGrant(claims());
    expect(decodeProtectedHeader(token)).toMatchObject({ typ: 'decision+jwt', alg: 'RS256' });
    expect(decodeJwt(token)).toMatchObject({ aud: DECISION_GRANT_AUDIENCE, sub: 'user:idp-user-1', dwell_ms: 61_250 });
    const verified = await verifyDecisionGrantSignature(token);
    expect(verified.action).toEqual(ACTION);
    expect(verified.approver_auth).toBe('sso+hwk');
  });

  it('refuses a tampered token, a grant token and an approver-session token', async () => {
    const token = await signDecisionGrant(claims());
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    payload['action'] = { ...ACTION, decision: 'decline' };
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    await expect(verifyDecisionGrantSignature(tampered)).rejects.toThrow(DecisionTokenError);

    const grantToken = await signGrantToken({ sub: 'user_1', agt: 'did:grantex:ag_1', dev: 'dev_TEST', scp: ['tool:acme_kyb:write'], jti: 'tok_1', exp: Math.floor(Date.now() / 1000) + 60 });
    await expect(verifyDecisionGrantSignature(grantToken)).rejects.toThrow(/typ/);
    const session = await signApproverSession('dsess_1', 'dev_TEST', Math.floor(Date.now() / 1000) + 60);
    await expect(verifyDecisionGrantSignature(session)).rejects.toThrow(DecisionTokenError);
  });

  it('refuses a correctly signed token with the right typ but a wrong audience or malformed claims', async () => {
    const { privateKey, kid } = getKeyPair();
    const forged = await new SignJWT({ ...claims(), aud: 'urn:other' })
      .setProtectedHeader({ alg: 'RS256', kid, typ: 'decision+jwt' })
      .setIssuer('https://grantex.dev')
      .sign(privateKey);
    await expect(verifyDecisionGrantSignature(forged)).rejects.toThrow(DecisionTokenError);
    const badAction = await signDecisionGrant({ ...claims(), action: { ...ACTION, extra: 1 } as unknown as DecisionAction });
    await expect(verifyDecisionGrantSignature(badAction)).rejects.toThrow(/action/);
  });

  it('approver sessions verify only as approver sessions', async () => {
    const session = await signApproverSession('dsess_01K00000000000000000000000', 'dev_TEST', Math.floor(Date.now() / 1000) + 60);
    await expect(verifyApproverSession(session)).resolves.toEqual({ sessionId: 'dsess_01K00000000000000000000000', developerId: 'dev_TEST' });
    const decision = await signDecisionGrant(claims());
    await expect(verifyApproverSession(decision)).rejects.toThrow(DecisionTokenError);
    const expired = await signApproverSession('dsess_01K00000000000000000000000', 'dev_TEST', Math.floor(Date.now() / 1000) - 5);
    await expect(verifyApproverSession(expired)).rejects.toThrow(DecisionTokenError);
  });
});
