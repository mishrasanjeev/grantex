/**
 * Decision-grant rules that need no database (PRD G-3): step-up evaluation,
 * approver identity, dwell-time bounds, expiry and the refusal taxonomy.
 * Everything here fails closed: an unreadable or ambiguous input is a refusal
 * with a reason, never a default.
 */
import { createHash } from 'node:crypto';

/** Absolute ceiling on a decision grant's lifetime, from minting and from the request. */
export const DECISION_MAX_LIFETIME_SECONDS = 86_400;

/**
 * Why a decision request, sign-in, approval or consumption was refused. The
 * first four are the PRD Appendix B sub-reasons of `decision_invalid`; the
 * others are documented in spec/decision-grant.md.
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
  AUTHENTICATION_FAILED: 'authentication_failed',
  DWELL_TOO_SHORT: 'dwell_too_short',
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
  /** How old an ID token (`iat`) may be when it is received. */
  idTokenMaxAgeSeconds: number;
}

export interface ApproverClaims {
  /** The identity provider's `sub`. */
  subject: string;
  acr?: string;
  amr: string[];
  authTime: number;
  /** Present only when the identity provider marked it verified. */
  verifiedEmail?: string;
  name?: string;
}

const AMR_VALUE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SUBJECT_RE = /^[\x21-\x7e]{1,255}$/;

/**
 * Reads the approver claims from an ID token payload whose signature,
 * issuer, audience, `azp`, `nonce` and expiry were already verified. Refuses a
 * token without a usable `sub` or `auth_time`, a stale `iat`, or malformed
 * `acr` / `amr`. An email counts only with `email_verified: true`.
 */
export function approverClaimsFromIdToken(payload: Record<string, unknown>, nowSeconds: number, policy: StepUpPolicy): ApproverClaims {
  const subject = payload['sub'];
  if (typeof subject !== 'string' || !SUBJECT_RE.test(subject)) {
    throw new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 401, 'ID token sub is missing or not a printable ASCII string of at most 255 characters');
  }
  const authTime = payload['auth_time'];
  if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime <= 0) {
    throw new DecisionError(DecisionSubReason.STEP_UP_REQUIRED, 403, 'ID token has no auth_time, so step-up cannot be established');
  }
  if (authTime > nowSeconds + 60) {
    throw new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 401, 'ID token auth_time is in the future');
  }
  const iat = payload['iat'];
  if (typeof iat !== 'number' || !Number.isFinite(iat) || iat > nowSeconds + 60 || nowSeconds - iat > policy.idTokenMaxAgeSeconds) {
    throw new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 401, `ID token must have been issued within the last ${policy.idTokenMaxAgeSeconds} seconds`);
  }
  const acr = payload['acr'];
  if (acr !== undefined && (typeof acr !== 'string' || acr.length === 0 || acr.length > 255)) {
    throw new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 401, 'ID token acr is malformed');
  }
  const amr = payload['amr'];
  let amrValues: string[] = [];
  if (amr !== undefined) {
    if (!Array.isArray(amr) || amr.length > 16 || !amr.every((v) => typeof v === 'string' && AMR_VALUE_RE.test(v))) {
      throw new DecisionError(DecisionSubReason.AUTHENTICATION_FAILED, 401, 'ID token amr is malformed');
    }
    amrValues = [...new Set(amr as string[])].sort();
  }
  const email = payload['email'];
  const verifiedEmail = payload['email_verified'] === true && typeof email === 'string' && email.length > 0 && email.length <= 320
    ? email
    : undefined;
  const name = typeof payload['name'] === 'string' && payload['name'].length <= 256 ? payload['name'] : undefined;
  return {
    subject,
    ...(typeof acr === 'string' ? { acr } : {}),
    amr: amrValues,
    authTime,
    ...(verifiedEmail !== undefined ? { verifiedEmail } : {}),
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

/**
 * The decision grant's `sub`: the identity provider's subject namespaced by
 * its issuer, `user:<first 22 base64url characters of SHA-256(issuer)>:<sub>`,
 * so the same `sub` at two identity providers is two approvers.
 */
export function approverSubject(issuer: string, idpSubject: string): string {
  const namespace = createHash('sha256').update(issuer, 'utf8').digest('base64url').slice(0, 22);
  return `user:${namespace}:${idpSubject}`;
}

export interface DwellPolicy {
  /** Approvals faster than this are refused (`dwell_too_short`). */
  minMs: number;
  /** Longest dwell recorded; longer views are recorded as this value. */
  maxMs: number;
}

/**
 * Dwell time measured by the service from rendering the approval page to its
 * submission (both server timestamps). Refuses a submission faster than the
 * configured minimum; caps the recorded value at the maximum.
 */
export function serverDwellMs(renderedAtMs: number, submittedAtMs: number, policy: DwellPolicy): number {
  const measured = Math.max(0, Math.floor(submittedAtMs - renderedAtMs));
  if (measured < policy.minMs) {
    throw new DecisionError(DecisionSubReason.DWELL_TOO_SHORT, 400, `The decision must be on screen for at least ${policy.minMs} ms before it is approved`);
  }
  return Math.min(measured, policy.maxMs);
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
