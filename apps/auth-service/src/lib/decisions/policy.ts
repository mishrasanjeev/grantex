/**
 * Decision-grant rules that need no database (PRD G-3): step-up evaluation,
 * approver identity, dwell-time bounds, expiry and the refusal taxonomy.
 * Everything here fails closed: an unreadable or ambiguous input is a refusal
 * with a reason, never a default.
 */

/** Absolute ceiling on a decision grant's lifetime, from minting and from the request. */
export const DECISION_MAX_LIFETIME_SECONDS = 86_400;

/**
 * Why a decision request, approval or consumption was refused. The first four
 * are the PRD Appendix B sub-reasons of `decision_invalid`; the others are
 * documented in spec/decision-grant.md.
 */
export const DecisionSubReason = {
  ACTION_MISMATCH: 'action_mismatch',
  EXPIRED: 'expired',
  CONSUMED: 'consumed',
  SAME_APPROVER: 'same_approver',
  CASE_CHANGED: 'case_changed',
  WRONG_CASE: 'wrong_case',
  STEP_UP_REQUIRED: 'step_up_required',
  REVOKED: 'revoked',
  UNKNOWN_GRANT: 'unknown_grant',
  MALFORMED: 'malformed',
  FOUR_EYES_INCOMPLETE: 'four_eyes_incomplete',
  CLOSED: 'closed',
} as const;
export type DecisionSubReason = (typeof DecisionSubReason)[keyof typeof DecisionSubReason];

export class DecisionError extends Error {
  readonly subReason: DecisionSubReason;
  readonly status: number;
  constructor(subReason: DecisionSubReason, status: number, message: string) {
    super(message);
    this.name = 'DecisionError';
    this.subReason = subReason;
    this.status = status;
  }
}

export interface StepUpPolicy {
  /** Accepted `acr` values; any one satisfies step-up. */
  acrValues: readonly string[];
  /** Accepted `amr` values; any one satisfies step-up. */
  amrValues: readonly string[];
  /** How long after `auth_time` a session counts as stepped up. */
  maxAgeSeconds: number;
  /** How old an ID token (`iat`) may be when it is exchanged. */
  idTokenMaxAgeSeconds: number;
}

export interface ApproverClaims {
  subject: string;
  acr?: string;
  amr: string[];
  authTime: number;
  email?: string;
  name?: string;
}

const AMR_VALUE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SUBJECT_RE = /^[\x21-\x7e]{1,255}$/;

/**
 * Reads the approver claims from a verified ID token payload. Refuses a token
 * without a usable `sub` or `auth_time`, or with malformed `acr`/`amr`.
 */
export function approverClaimsFromIdToken(payload: Record<string, unknown>, nowSeconds: number, policy: StepUpPolicy): ApproverClaims {
  const subject = payload['sub'];
  if (typeof subject !== 'string' || !SUBJECT_RE.test(subject)) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'ID token sub is missing or not a printable ASCII string of at most 255 characters');
  }
  const authTime = payload['auth_time'];
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0) {
    throw new DecisionError(DecisionSubReason.STEP_UP_REQUIRED, 403, 'ID token has no auth_time, so step-up cannot be established');
  }
  if (authTime > nowSeconds + 60) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'ID token auth_time is in the future');
  }
  const iat = payload['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat) || nowSeconds - iat > policy.idTokenMaxAgeSeconds) {
    throw new DecisionError(DecisionSubReason.EXPIRED, 401, `ID token must have been issued within the last ${policy.idTokenMaxAgeSeconds} seconds`);
  }
  const acr = payload['acr'];
  if (acr !== undefined && (typeof acr !== 'string' || acr.length === 0 || acr.length > 255)) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'ID token acr is malformed');
  }
  const amr = payload['amr'];
  let amrValues: string[] = [];
  if (amr !== undefined) {
    if (!Array.isArray(amr) || amr.length > 16 || !amr.every((v) => typeof v === 'string' && AMR_VALUE_RE.test(v))) {
      throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'ID token amr is malformed');
    }
    amrValues = [...new Set(amr as string[])].sort();
  }
  const email = typeof payload['email'] === 'string' && payload['email'].length <= 320 ? payload['email'] : undefined;
  const name = typeof payload['name'] === 'string' && payload['name'].length <= 256 ? payload['name'] : undefined;
  return {
    subject,
    ...(typeof acr === 'string' ? { acr } : {}),
    amr: amrValues,
    authTime,
    ...(email !== undefined ? { email } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

/** Whether the authentication counts as step-up, ignoring its age. */
export function satisfiesStepUpMethod(claims: Pick<ApproverClaims, 'acr' | 'amr'>, policy: StepUpPolicy): boolean {
  if (claims.acr !== undefined && policy.acrValues.includes(claims.acr)) return true;
  return claims.amr.some((value) => policy.amrValues.includes(value));
}

/** Throws `step_up_required` unless the authentication is step-up and recent enough. */
export function assertStepUp(claims: Pick<ApproverClaims, 'acr' | 'amr' | 'authTime'>, nowSeconds: number, policy: StepUpPolicy): void {
  if (!satisfiesStepUpMethod(claims, policy)) {
    throw new DecisionError(
      DecisionSubReason.STEP_UP_REQUIRED,
      403,
      'The approver has not completed step-up authentication (no accepted acr or amr value)',
    );
  }
  if (nowSeconds - claims.authTime > policy.maxAgeSeconds) {
    throw new DecisionError(
      DecisionSubReason.STEP_UP_REQUIRED,
      403,
      `Step-up authentication is older than ${policy.maxAgeSeconds} seconds; authenticate again`,
    );
  }
}

/**
 * The `approver_auth` claim: `sso` followed by `+<amr>` for every
 * authentication method the identity provider reported, sorted, for example
 * `sso+hwk+pwd`. With no `amr`, `sso+acr`.
 */
export function approverAuthMethod(claims: Pick<ApproverClaims, 'amr'>): string {
  return claims.amr.length > 0 ? `sso+${claims.amr.join('+')}` : 'sso+acr';
}

/** The decision grant's `sub` for an identity-provider subject. */
export function approverSubject(idpSubject: string): string {
  return `user:${idpSubject}`;
}

export interface DwellPolicy {
  minMs: number;
  maxMs: number;
}

/**
 * Validates a dwell time supplied by an approval surface: an integer within
 * the configured range and no longer than the request has existed (plus five
 * seconds of clock skew).
 */
export function validateDwellMs(value: unknown, requestCreatedAtMs: number, nowMs: number, policy: DwellPolicy): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'dwellMs must be an integer number of milliseconds');
  }
  if (value < policy.minMs || value > policy.maxMs) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, `dwellMs must be between ${policy.minMs} and ${policy.maxMs}`);
  }
  if (value > nowMs - requestCreatedAtMs + 5_000) {
    throw new DecisionError(DecisionSubReason.MALFORMED, 400, 'dwellMs is longer than the decision request has existed');
  }
  return value;
}

/** Expiry of a decision grant minted now for a request expiring at `requestExpiresAtMs`. */
export function decisionGrantExpiry(nowSeconds: number, requestExpiresAtMs: number): number {
  return Math.min(nowSeconds + DECISION_MAX_LIFETIME_SECONDS, Math.floor(requestExpiresAtMs / 1000));
}

const CASE_VERSION_RE = /^[\x21-\x7e]{1,128}$/;
const REF_RE = /^[\x20-\x7e]{1,512}$/;
const CONNECTOR_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export function isCaseVersion(value: unknown): value is string {
  return typeof value === 'string' && CASE_VERSION_RE.test(value);
}

export function isReference(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value);
}

export function isConnectorName(value: unknown): value is string {
  return typeof value === 'string' && CONNECTOR_RE.test(value);
}
