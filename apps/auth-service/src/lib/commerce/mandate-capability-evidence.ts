// SPDX-License-Identifier: LicenseRef-Orchestrum-Personal-Use-1.0
/**
 * Mandate-capability evidence (G43): the redacted result of AgenticOrg's
 * provider capability verifier (`verify_plural_pine_mandate_capability` for
 * the Plural rail), which Grantex binds into the signed `mandate_capability`
 * artifact instead of a placeholder reference.
 *
 * The object is closed (unknown members are refused) and holds no secrets:
 * references, rails, caps, token types, timestamps and hashes only. Without
 * it the artifact says `mandate_capability_status: "unverified"` and carries
 * no evidence reference at all; with a provider result other than
 * `available` it says `unavailable`. Only `verified` backs a checkout.
 */
import { createHash } from 'node:crypto';
import { canonicalizeOacpPayload } from './oacp-trust-artifacts.js';
import {
  MANDATE_CAPABILITY_PROVIDERS,
  OACP_PAYMENT_RAILS,
  type MandateCapabilityProvider,
  type OacpPaymentRail,
} from './payment-providers/mandate-rails.js';

export const MANDATE_CAPABILITY_EVIDENCE_VERSION = 'oacp.mandate_capability_evidence.v1';
/** The verifier's own validity window (AgenticOrg: checked_at + 6 h). */
export const MANDATE_CAPABILITY_EVIDENCE_MAX_AGE_SECONDS = 6 * 60 * 60;
const SKEW_MS = 60_000;

export const MANDATE_CAPABILITY_RESULT_STATUSES = [
  'available',
  'unavailable',
  'blocked_missing_credentials',
  'blocked_provider_error',
] as const;

export type MandateCapabilityStatus = 'verified' | 'unavailable' | 'unverified';

export interface MandateCapabilityEvidence {
  schema_version: typeof MANDATE_CAPABILITY_EVIDENCE_VERSION;
  evidence_id: string;
  tenant_id: string;
  merchant_id: string;
  provider: MandateCapabilityProvider;
  provider_environment: 'sandbox' | 'production';
  result_status: typeof MANDATE_CAPABILITY_RESULT_STATUSES[number];
  external_validation_performed: boolean;
  rails: OacpPaymentRail[];
  caps: Array<{ rail: OacpPaymentRail; max_amount: number; currency: string }>;
  token_types: string[];
  verified_at: string;
  expires_at: string;
  redacted_evidence_ref: string;
  /** Lowercase hex SHA-256 the verifier computed over the redacted provider response. */
  evidence_hash: string;
}

/** What the artifact payload carries: the evidence plus Grantex's hash of it. */
export interface BoundMandateCapabilityEvidence extends Omit<MandateCapabilityEvidence, 'tenant_id' | 'merchant_id'> {
  /** Lowercase hex SHA-256 of the RFC 8785 form of the evidence object as received. */
  evidence_object_hash: string;
}

export class MandateCapabilityEvidenceError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'MandateCapabilityEvidenceError';
  }
}

const FIELDS = new Set([
  'schema_version', 'evidence_id', 'tenant_id', 'merchant_id', 'provider', 'provider_environment',
  'result_status', 'external_validation_performed', 'rails', 'caps', 'token_types', 'verified_at',
  'expires_at', 'redacted_evidence_ref', 'evidence_hash',
]);
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const TOKEN_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(field: string, message: string): never {
  throw new MandateCapabilityEvidenceError(field, message);
}

function isoMillis(value: unknown, field: string): number {
  const millis = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) fail(field, 'must be an RFC 3339 timestamp');
  return millis;
}

/**
 * Validate the evidence for one tenant / merchant scope at `nowIso`. Throws
 * `MandateCapabilityEvidenceError` for anything malformed, out of scope,
 * stale, from the future, or carrying members beyond the closed set.
 */
export function parseMandateCapabilityEvidence(
  value: unknown,
  scope: { tenant_id: string; merchant_id: string },
  nowIso: string,
): MandateCapabilityEvidence {
  if (!isRecord(value)) fail('mandate_capability_evidence', 'must be an object');
  const unknown = Object.keys(value).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) fail(unknown, 'unknown member; the evidence object is closed and holds no secrets');
  if (value['schema_version'] !== MANDATE_CAPABILITY_EVIDENCE_VERSION) fail('schema_version', `must be ${MANDATE_CAPABILITY_EVIDENCE_VERSION}`);
  for (const field of ['evidence_id', 'redacted_evidence_ref']) {
    if (typeof value[field] !== 'string' || !REF.test(value[field] as string)) fail(field, 'must be an opaque reference');
  }
  if (/:pending:/.test(value['redacted_evidence_ref'] as string)) fail('redacted_evidence_ref', 'a pending placeholder is not evidence');
  if (value['tenant_id'] !== scope.tenant_id || value['merchant_id'] !== scope.merchant_id) {
    fail('tenant_id', 'evidence must be for the authority request tenant and merchant');
  }
  if (!(MANDATE_CAPABILITY_PROVIDERS as readonly unknown[]).includes(value['provider'])) {
    fail('provider', `must be one of ${MANDATE_CAPABILITY_PROVIDERS.join(', ')}`);
  }
  if (value['provider_environment'] !== 'sandbox' && value['provider_environment'] !== 'production') {
    fail('provider_environment', 'must be sandbox or production');
  }
  if (!(MANDATE_CAPABILITY_RESULT_STATUSES as readonly unknown[]).includes(value['result_status'])) {
    fail('result_status', `must be one of ${MANDATE_CAPABILITY_RESULT_STATUSES.join(', ')}`);
  }
  if (typeof value['external_validation_performed'] !== 'boolean') fail('external_validation_performed', 'must be a boolean');
  const rails = value['rails'];
  if (!Array.isArray(rails) || rails.length > OACP_PAYMENT_RAILS.length
    || !rails.every((rail) => (OACP_PAYMENT_RAILS as readonly unknown[]).includes(rail))
    || new Set(rails).size !== rails.length) {
    fail('rails', `must be distinct values of ${OACP_PAYMENT_RAILS.join(', ')}`);
  }
  const caps = value['caps'];
  if (!Array.isArray(caps) || caps.length > 16 || !caps.every((cap) => isRecord(cap)
    && Object.keys(cap).every((k) => k === 'rail' || k === 'max_amount' || k === 'currency')
    && (rails as unknown[]).includes(cap['rail'])
    && typeof cap['max_amount'] === 'number' && Number.isSafeInteger(cap['max_amount']) && cap['max_amount'] >= 0
    && typeof cap['currency'] === 'string' && /^[A-Z]{3}$/.test(cap['currency']))) {
    fail('caps', 'must be [{rail (one of rails), max_amount (integer minor units), currency (ISO 4217)}]');
  }
  const tokenTypes = value['token_types'];
  if (!Array.isArray(tokenTypes) || tokenTypes.length > 16 || !tokenTypes.every((t) => typeof t === 'string' && TOKEN_TYPE.test(t))) {
    fail('token_types', 'must be token type names');
  }
  if (typeof value['evidence_hash'] !== 'string' || !HEX64.test(value['evidence_hash'])) fail('evidence_hash', 'must be lowercase hex SHA-256');
  const now = isoMillis(nowIso, 'now');
  const verifiedAt = isoMillis(value['verified_at'], 'verified_at');
  const expiresAt = isoMillis(value['expires_at'], 'expires_at');
  if (verifiedAt > now + SKEW_MS) fail('verified_at', 'is in the future');
  if (now - verifiedAt > MANDATE_CAPABILITY_EVIDENCE_MAX_AGE_SECONDS * 1000) fail('verified_at', 'evidence is stale');
  if (expiresAt <= verifiedAt || expiresAt <= now) fail('expires_at', 'evidence has expired');
  if (value['result_status'] === 'available' && (value['external_validation_performed'] !== true || rails.length === 0)) {
    fail('result_status', 'an available capability needs an external validation and at least one rail');
  }
  return value as unknown as MandateCapabilityEvidence;
}

/** The artifact's capability status and evidence for parsed (or absent) evidence. */
export function bindMandateCapabilityEvidence(evidence: MandateCapabilityEvidence | null): {
  status: MandateCapabilityStatus;
  evidence: BoundMandateCapabilityEvidence | null;
} {
  if (!evidence) return { status: 'unverified', evidence: null };
  const { tenant_id: _tenant, merchant_id: _merchant, ...rest } = evidence;
  return {
    status: evidence.result_status === 'available' ? 'verified' : 'unavailable',
    evidence: {
      ...rest,
      evidence_object_hash: createHash('sha256').update(canonicalizeOacpPayload(evidence), 'utf8').digest('hex'),
    },
  };
}
