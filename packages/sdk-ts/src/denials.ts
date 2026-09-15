/**
 * Denial taxonomy for `enforce()` (PRD Appendix B).
 *
 * Every denied `EnforceResult` carries a `reasonCode` and, where one applies,
 * a `subReason`. `reason` stays a human-readable sentence; code against
 * `reasonCode`. The codes are stable, low-cardinality strings suitable for
 * metric labels and audit records, identical to the Python SDK's.
 */

export const DenialReason = {
  /** The grant's purpose matches none of the tool's `allowed_purposes`, or it has none. */
  PURPOSE_NOT_ALLOWED: 'purpose_not_allowed',
  /** No scope in the grant covers the connector or tool. */
  TOOL_NOT_GRANTED: 'tool_not_granted',
  /** A scope covers the connector but at a lower permission level. */
  PERMISSION_INSUFFICIENT: 'permission_insufficient',
  /** A call cap, cost-unit budget or amount cap would be exceeded, or cannot be evaluated. */
  CAP_EXCEEDED: 'cap_exceeded',
  /** The tool declares `requires_decision` and no decision grant was given. */
  DECISION_REQUIRED: 'decision_required',
  /** A decision grant was given but is not valid for this action. */
  DECISION_INVALID: 'decision_invalid',
  /** The grant has been revoked. */
  GRANT_REVOKED: 'grant_revoked',
  /** The grant's data region does not permit this call. */
  REGION_MISMATCH: 'region_mismatch',
  /** No manifest is loaded for the connector, or it does not declare the tool. */
  MANIFEST_UNKNOWN_TOOL: 'manifest_unknown_tool',
  /** The grant token failed verification. Not part of Appendix B, which assumes a verified grant. */
  TOKEN_INVALID: 'token_invalid',
} as const;

export type DenialReason = (typeof DenialReason)[keyof typeof DenialReason];

/** Sub-reasons for `manifest_unknown_tool`. */
export const ManifestSubReason = {
  UNKNOWN_CONNECTOR: 'unknown_connector',
  UNKNOWN_TOOL: 'unknown_tool',
  INVALID_DECLARATION: 'invalid_declaration',
} as const;

/** Sub-reasons for `cap_exceeded`. */
export const CapSubReason = {
  /** `amount` is above a `capped:N` scope. */
  AMOUNT_CAP: 'amount_cap',
  /** `amount` is not a finite number. */
  INVALID_AMOUNT: 'invalid_amount',
  /** A `capped:N` scope carries a malformed cap. */
  MALFORMED_CAP: 'malformed_cap',
  /** The tool declares caps or cost units and they cannot be metered. */
  METER_UNAVAILABLE: 'meter_unavailable',
} as const;

/** Sub-reasons for `purpose_not_allowed`. */
export const PurposeSubReason = {
  /** The grant carries no purpose. */
  MISSING: 'missing',
  /** The grant's purpose matches none of the tool's patterns. */
  NOT_MATCHED: 'not_matched',
  /** The grant's purpose is malformed or not in the purpose vocabulary. */
  UNKNOWN_PURPOSE: 'unknown_purpose',
} as const;

/** Sub-reasons for `tool_not_granted`. */
export const ToolSubReason = {
  /** The grant's tools entry for the connector does not list the tool. */
  NOT_IN_AUTHORIZATION_DETAILS: 'not_in_authorization_details',
} as const;

/** Sub-reasons for `token_invalid`. */
export const TokenSubReason = {
  /** The `authorization_details` claim cannot be read unambiguously. */
  MALFORMED_AUTHORIZATION_DETAILS: 'malformed_authorization_details',
} as const;
