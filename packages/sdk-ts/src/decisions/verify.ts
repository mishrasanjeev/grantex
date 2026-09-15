/**
 * Offline verification of decision grants (PRD G-3).
 *
 * Verification proves that a decision grant is authentic, unexpired and
 * approves exactly the action about to be performed on the current case
 * version, and, for four eyes, that two different people approved it. It does
 * not prove that the grant has not been used: that needs the issuer's atomic
 * consumption (`grantex.decisions.consume()`), which `enforce()` performs
 * before it allows the call. The Python SDK implements the same rules
 * (`grantex.decisions`); the token profile is `spec/decision-grant.md`.
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { DecisionSubReason } from '../denials.js';
import { ActionValidationError, computeActionHash, isActionHash, parseDecisionAction, type DecisionAction } from './action.js';

export const DECISION_GRANT_TYP = 'decision+jwt';
export const DECISION_GRANT_AUDIENCE = 'urn:grantex:decision';

const JTI_RE = /^dgnt_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TOKEN_LENGTH = 16_384;

/** A decision grant is absent, unusable or does not match the call. */
export class DecisionGrantError extends Error {
  readonly subReason: DecisionSubReason;
  constructor(subReason: DecisionSubReason, message: string) {
    super(message);
    this.name = 'DecisionGrantError';
    this.subReason = subReason;
  }
}

export interface FourEyes {
  approvalsRequired: 2;
  position: 1 | 2;
  firstJti?: string;
  firstSub?: string;
}

/** The verified claims of one decision grant. */
export interface DecisionGrant {
  token: string;
  jti: string;
  iss: string;
  sub: string;
  dev: string;
  idp: string;
  approverAuth: string;
  acr?: string;
  amr: string[];
  authTime: number;
  action: DecisionAction;
  actionHash: string;
  connector: string;
  caseVersion: string;
  dwellMs: number;
  /** Always `server`: the issuer measured the dwell time. */
  dwellSource: 'server';
  decisionRequest: string;
  memoHash: string;
  policyScoreHash: string;
  iat: number;
  exp: number;
  memoRef?: string;
  policyScoreRef?: string;
  fourEyes?: FourEyes;
}

/** Decision grants that together authorise one action. */
export interface DecisionGrantSet {
  grants: DecisionGrant[];
  action: DecisionAction;
  actionHash: string;
  caseVersion: string;
  approvalsRequired: 1 | 2;
}

/** A verification key, or a resolver that picks one from the protected header. */
export type DecisionKey = CryptoKey | Uint8Array | JWTVerifyGetKey;

export interface VerifyDecisionGrantOptions {
  /** Expected `iss`. */
  issuer: string;
  /** JWKS URL of the issuer; used when `key` is not given. */
  jwksUri?: string;
  /** Verification key or resolver; overrides `jwksUri`. */
  key?: DecisionKey;
  /** The grant must have been issued to this developer (`dev`). */
  developerId?: string;
  /** The grant must be for this connector. */
  connector?: string;
  /** Accepted algorithms, a subset of RS256 and ES256. Default both. */
  algorithms?: string[];
  /** Seconds of clock tolerance. Default 0. */
  clockTolerance?: number;
  /** Current time in seconds (for tests). */
  now?: number;
}

export interface VerifyDecisionGrantsOptions extends VerifyDecisionGrantOptions {
  /** 2 when the manifest lists the decision in `four_eyes_on`. Default 1. */
  approvalsRequired?: 1 | 2;
}

const MAX_JWKS_RESOLVERS = 64;
const jwksResolvers = new Map<string, JWTVerifyGetKey>();

function remoteKey(jwksUri: string): JWTVerifyGetKey {
  const url = new URL(jwksUri);
  url.hash = '';
  const cached = jwksResolvers.get(url.href);
  if (cached) return cached;
  const resolver = createRemoteJWKSet(url);
  if (jwksResolvers.size >= MAX_JWKS_RESOLVERS) {
    const oldest = jwksResolvers.keys().next().value as string | undefined;
    if (oldest !== undefined) jwksResolvers.delete(oldest);
  }
  jwksResolvers.set(url.href, resolver);
  return resolver;
}

function toAction(value: unknown): DecisionAction {
  try {
    return parseDecisionAction(value);
  } catch (err) {
    if (err instanceof ActionValidationError) {
      throw new DecisionGrantError(DecisionSubReason.MALFORMED, `expected action is invalid: ${err.message}`);
    }
    throw err;
  }
}

function claimString(payload: JWTPayload, key: string): string {
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, `decision grant claim ${key} is missing`);
  }
  return value;
}

function claimInt(payload: JWTPayload, key: string): number {
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, `decision grant claim ${key} is invalid`);
  }
  return value;
}

function parseFourEyes(value: unknown): FourEyes | undefined {
  if (value === undefined) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || v['approvals_required'] !== 2 || (v['position'] !== 1 && v['position'] !== 2)) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant four_eyes is invalid');
  }
  const firstJti = v['first_jti'];
  const firstSub = v['first_sub'];
  if (v['position'] === 2 && (typeof firstJti !== 'string' || typeof firstSub !== 'string')) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'the second approval must name the first');
  }
  return {
    approvalsRequired: 2,
    position: v['position'],
    ...(typeof firstJti === 'string' ? { firstJti } : {}),
    ...(typeof firstSub === 'string' ? { firstSub } : {}),
  };
}

/**
 * Verifies one decision grant against the action about to be performed.
 * Refusals (`DecisionGrantError.subReason`): `malformed` (type, signature,
 * issuer, audience, claims, or an `action_hash` that is not the hash of the
 * `action` claim), `unknown_grant` (another developer), `wrong_case`,
 * `action_mismatch` (another action or connector), `case_changed`, `expired`.
 * Single use is not checked here.
 */
export async function verifyDecisionGrant(
  token: string,
  expectedAction: DecisionAction,
  caseVersion: string,
  options: VerifyDecisionGrantOptions,
): Promise<DecisionGrant> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant must be a compact JWT');
  }
  const expected = toAction(expectedAction);
  if (typeof caseVersion !== 'string' || caseVersion.length === 0) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'caseVersion is required');
  }
  const algorithms: string[] = (options.algorithms ?? ['RS256', 'ES256']).filter((a) => a === 'RS256' || a === 'ES256');
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant is not a JWT');
  }
  if (header.typ !== DECISION_GRANT_TYP) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, `decision grant typ must be ${DECISION_GRANT_TYP}`);
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant has no kid');
  }
  if (typeof header.alg !== 'string' || !algorithms.includes(header.alg)) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, `decision grant algorithm ${String(header.alg)} is not allowed`);
  }
  const key = options.key ?? (options.jwksUri !== undefined ? remoteKey(options.jwksUri) : undefined);
  if (key === undefined) throw new Error('verifyDecisionGrant needs jwksUri or key');

  let payload: JWTPayload;
  try {
    const verifyOptions = {
      issuer: options.issuer,
      audience: DECISION_GRANT_AUDIENCE,
      algorithms,
      typ: DECISION_GRANT_TYP,
      requiredClaims: ['iss', 'aud', 'sub', 'jti', 'iat', 'exp'],
      // Time is checked below against `now`, after the signature.
      currentDate: new Date(0),
    };
    ({ payload } = typeof key === 'function'
      ? await jwtVerify(token, key, verifyOptions)
      : await jwtVerify(token, key, verifyOptions));
  } catch (err) {
    throw new DecisionGrantError(
      DecisionSubReason.MALFORMED,
      `decision grant signature, issuer or audience is invalid: ${err instanceof Error ? err.message : 'verification failed'}`,
    );
  }

  const jti = claimString(payload, 'jti');
  if (!JTI_RE.test(jti)) throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant jti is malformed');
  let action: DecisionAction;
  try {
    action = parseDecisionAction(payload['action']);
  } catch {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant action is malformed');
  }
  const actionHash = claimString(payload, 'action_hash');
  if (!isActionHash(actionHash) || computeActionHash(action) !== actionHash) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant action_hash does not match its action');
  }
  const amr = payload['amr'];
  if (!Array.isArray(amr) || !amr.every((v) => typeof v === 'string')) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant amr is invalid');
  }
  const acr = payload['acr'];
  if (acr !== undefined && typeof acr !== 'string') {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant acr is invalid');
  }
  if (payload['dwell_source'] !== 'server') {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant dwell time was not measured by the issuer');
  }
  const memoHash = claimString(payload, 'memo_hash');
  const policyScoreHash = claimString(payload, 'policy_score_hash');
  if (!isActionHash(memoHash) || !isActionHash(policyScoreHash)) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant memo or policy score hash is malformed');
  }
  const iat = claimInt(payload, 'iat');
  const exp = claimInt(payload, 'exp');
  if (exp <= iat || exp - iat > 86_400) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant lifetime exceeds 24 hours');
  }
  const memoRef = payload['memo_ref'];
  const policyScoreRef = payload['policy_score_ref'];
  const fourEyes = parseFourEyes(payload['four_eyes']);
  const grant: DecisionGrant = {
    token,
    jti,
    iss: claimString(payload, 'iss'),
    sub: claimString(payload, 'sub'),
    dev: claimString(payload, 'dev'),
    idp: claimString(payload, 'idp'),
    approverAuth: claimString(payload, 'approver_auth'),
    ...(typeof acr === 'string' ? { acr } : {}),
    amr: amr as string[],
    authTime: claimInt(payload, 'auth_time'),
    action,
    actionHash,
    connector: claimString(payload, 'connector'),
    caseVersion: claimString(payload, 'case_version'),
    dwellMs: claimInt(payload, 'dwell_ms'),
    dwellSource: 'server',
    decisionRequest: claimString(payload, 'decision_request'),
    memoHash,
    policyScoreHash,
    iat,
    exp,
    ...(typeof memoRef === 'string' ? { memoRef } : {}),
    ...(typeof policyScoreRef === 'string' ? { policyScoreRef } : {}),
    ...(fourEyes !== undefined ? { fourEyes } : {}),
  };

  if (options.developerId !== undefined && grant.dev !== options.developerId) {
    throw new DecisionGrantError(DecisionSubReason.UNKNOWN_GRANT, 'decision grant was issued to another developer');
  }
  if (grant.action.case_id !== expected.case_id) {
    throw new DecisionGrantError(DecisionSubReason.WRONG_CASE, 'decision grant is for another case');
  }
  if (grant.actionHash !== computeActionHash(expected)) {
    throw new DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, 'decision grant approves a different action');
  }
  if (options.connector !== undefined && grant.connector !== options.connector) {
    throw new DecisionGrantError(DecisionSubReason.ACTION_MISMATCH, 'decision grant approves an action on another connector');
  }
  if (grant.caseVersion !== caseVersion) {
    throw new DecisionGrantError(DecisionSubReason.CASE_CHANGED, 'decision grant was approved for another case version');
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.clockTolerance ?? 0;
  if (grant.iat > now + tolerance + 60) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grant is issued in the future');
  }
  if (now >= grant.exp + tolerance) {
    throw new DecisionGrantError(DecisionSubReason.EXPIRED, 'decision grant has expired');
  }
  return grant;
}

/**
 * Verifies the decision grants for one action, including four eyes: with two
 * approvals required (from the manifest, or because a grant says so) exactly
 * two grants with different `sub` are needed, the second naming the first.
 */
export async function verifyDecisionGrants(
  tokens: readonly string[],
  expectedAction: DecisionAction,
  caseVersion: string,
  options: VerifyDecisionGrantsOptions,
): Promise<DecisionGrantSet> {
  const approvalsRequired = options.approvalsRequired ?? 1;
  if (approvalsRequired !== 1 && approvalsRequired !== 2) throw new Error('approvalsRequired must be 1 or 2');
  if (!Array.isArray(tokens)) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'decision grants must be an array of tokens');
  }
  if (tokens.length === 0) throw new DecisionGrantError(DecisionSubReason.ABSENT, 'no decision grant was presented');
  if (tokens.length > 2) throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'at most two decision grants can be presented');
  const expected = toAction(expectedAction);
  const grants: DecisionGrant[] = [];
  for (const token of tokens) grants.push(await verifyDecisionGrant(token, expected, caseVersion, options));

  const required: 1 | 2 = grants.some((g) => g.fourEyes !== undefined) ? 2 : approvalsRequired;
  if (new Set(grants.map((g) => g.jti)).size !== grants.length) {
    throw new DecisionGrantError(DecisionSubReason.SAME_APPROVER, 'the same decision grant was presented twice');
  }
  if (grants.length < required) {
    throw new DecisionGrantError(DecisionSubReason.FOUR_EYES_INCOMPLETE, 'this decision needs two approvals from different people');
  }
  if (grants.length > required) {
    throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'more decision grants than this decision needs');
  }
  let ordered = grants;
  if (required === 2) {
    const [first, second] = [...grants].sort((a, b) => (a.fourEyes?.position ?? 0) - (b.fourEyes?.position ?? 0)) as [DecisionGrant, DecisionGrant];
    if (first.sub === second.sub) {
      throw new DecisionGrantError(DecisionSubReason.SAME_APPROVER, 'both decision grants were approved by the same person');
    }
    if (first.fourEyes?.position !== 1 || second.fourEyes?.position !== 2
        || second.fourEyes.firstJti !== first.jti || second.fourEyes.firstSub !== first.sub
        || first.decisionRequest !== second.decisionRequest) {
      throw new DecisionGrantError(DecisionSubReason.MALFORMED, 'the second approval does not reference the first');
    }
    ordered = [first, second];
  }
  return { grants: ordered, action: expected, actionHash: computeActionHash(expected), caseVersion, approvalsRequired: required };
}
