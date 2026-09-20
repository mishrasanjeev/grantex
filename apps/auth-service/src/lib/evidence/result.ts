/** Verification codes, results and errors for evidence packages. */

export const VerificationCode = {
  MISSING_ROOT: 'missing_root',
  TOO_LARGE: 'too_large',
  MALFORMED_JSON: 'malformed_json',
  DUPLICATE_KEY: 'duplicate_key',
  NON_CANONICAL_NUMBER: 'non_canonical_number',
  NON_CANONICAL_DOCUMENT: 'non_canonical_document',
  UNSUPPORTED_FORMAT: 'unsupported_format',
  UNSUPPORTED_VERSION: 'unsupported_version',
  SCHEMA_VIOLATION: 'schema_violation',
  PRIVACY_VIOLATION: 'privacy_violation',
  GENESIS_MISMATCH: 'genesis_mismatch',
  SEQUENCE_MISMATCH: 'sequence_mismatch',
  LINK_MISMATCH: 'link_mismatch',
  ENTRY_HASH_MISMATCH: 'entry_hash_mismatch',
  HEAD_MISMATCH: 'head_mismatch',
  LENGTH_MISMATCH: 'length_mismatch',
  ROOT_MISMATCH: 'root_mismatch',
  GRANT_CHAIN_BROKEN: 'grant_chain_broken',
  ENTRIES_OUT_OF_ORDER: 'entries_out_of_order',
  DUPLICATE_IDENTIFIER: 'duplicate_identifier',
  DANGLING_REFERENCE: 'dangling_reference',
  CASE_MISMATCH: 'case_mismatch',
  ACTION_HASH_MISMATCH: 'action_hash_mismatch',
  DECISION_INCONSISTENT: 'decision_inconsistent',
  VALIDITY_VIOLATION: 'validity_violation',
  AUTHORITY_VIOLATION: 'authority_violation',
  TOOL_CALL_INCONSISTENT: 'tool_call_inconsistent',
  ROOT_NOT_TRUSTED: 'root_not_trusted',
  ANCHOR_MISSING: 'anchor_missing',
  ANCHOR_HASH_MISMATCH: 'anchor_hash_mismatch',
  ANCHOR_MISMATCH: 'anchor_mismatch',
  ANCHOR_NOT_TRUSTED: 'anchor_not_trusted',
  SIGNATURE_MISSING: 'signature_missing',
  SIGNATURE_UNVERIFIED: 'signature_unverified',
  SIGNATURE_KEY_UNKNOWN: 'signature_key_unknown',
  SIGNATURE_INVALID: 'signature_invalid',
} as const;

export type VerificationCodeValue = (typeof VerificationCode)[keyof typeof VerificationCode];

export interface FailureLocation {
  entryIndex?: number | null;
  fieldPath?: string | null;
  expected?: string | null;
  actual?: string | null;
}

/** The first failed check. Thrown internally, reported in the result. */
export class VerificationFailure extends Error {
  readonly code: VerificationCodeValue;
  readonly entryIndex: number | null;
  readonly fieldPath: string | null;
  readonly expected: string | null;
  readonly actual: string | null;

  constructor(code: VerificationCodeValue, message: string, location: FailureLocation = {}) {
    super(message);
    this.name = 'VerificationFailure';
    this.code = code;
    this.entryIndex = location.entryIndex ?? null;
    this.fieldPath = location.fieldPath ?? null;
    this.expected = location.expected ?? null;
    this.actual = location.actual ?? null;
  }
}

/**
 * Outcome of `verifyPackage`. `ok` is true only when every check passed;
 * otherwise `code` names the first check that failed and `entryIndex`,
 * `fieldPath`, `expected` and `actual` locate it where that is meaningful.
 */
export interface VerificationResult {
  ok: boolean;
  code: VerificationCodeValue | null;
  message: string;
  entryIndex: number | null;
  fieldPath: string | null;
  expected: string | null;
  actual: string | null;
  root: string | null;
  entryCount: number | null;
  /** `absent`, `internal-consistency-only`, `pinned` (matches a caller-supplied anchor hash) or `signed`. */
  anchorStatus: 'absent' | 'internal-consistency-only' | 'pinned' | 'signed';
  /** `absent`, `unchecked` or `verified`. Only a verified service signature proves who exported the package. */
  signatureStatus: 'absent' | 'unchecked' | 'verified';
  signatureKid: string | null;
  unsourcedInputs: number;
  lateEntries: number;
  tenantAssertedEntries: number;
}

/** JSON form of a result, identical to the Python SDK's `VerificationResult.to_dict()`. */
export function verificationResultToJson(result: VerificationResult): Record<string, unknown> {
  return {
    ok: result.ok,
    code: result.code,
    message: result.message,
    entry_index: result.entryIndex,
    field_path: result.fieldPath,
    expected: result.expected,
    actual: result.actual,
    root: result.root,
    entry_count: result.entryCount,
    anchor_status: result.anchorStatus,
    signature_status: result.signatureStatus,
    signature_kid: result.signatureKid,
    unsourced_inputs: result.unsourcedInputs,
    late_entries: result.lateEntries,
    tenant_asserted_entries: result.tenantAssertedEntries,
  };
}

/** A package could not be built from the given input. */
export class EvidenceBuildError extends Error {
  readonly code: string;
  readonly fieldPath: string | null;

  constructor(code: string, message: string, fieldPath: string | null = null) {
    super(`${code}: ${message}${fieldPath ? ` at ${fieldPath}` : ''}`);
    this.name = 'EvidenceBuildError';
    this.code = code;
    this.fieldPath = fieldPath;
  }
}
