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
  /** The tool declares caps or cost units and they cannot be metered: no meter, or its backend is unavailable. */
  METER_UNAVAILABLE: 'meter_unavailable',
  /**
   * A call cap or cost-unit budget would be exceeded (error code E1008). `details`
   * carries `code`, `limit`, `window`, `used`, `requested`, `scope` and `kind`.
   */
  LIMIT_REACHED: 'limit_reached',
  /** A per-case cap applies and no `caseId` was given. */
  CASE_REQUIRED: 'case_required',
  INVALID_CASE_ID: 'invalid_case_id',
  /** `costComponents` names a unit the tool does not declare. */
  INVALID_COST_COMPONENT: 'invalid_cost_component',
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

/**
 * Sub-reasons for `grant_revoked` (PRD G-6). A call is denied both when the
 * grant is known to be revoked and when the client cannot tell: an SDK that
 * has lost the revocation feed must not keep authorising calls.
 */
export const RevocationSubReason = {
  /** The auth service says this grant or token is revoked. */
  REVOKED: 'revoked',
  /** The grant is suspended: revoked reversibly, pending a decision. */
  SUSPENDED: 'suspended',
  /** A grant above this one in the delegation chain is revoked or suspended. */
  PARENT_REVOKED: 'parent_revoked',
  /** The revocation feed has not heard from the auth service inside its staleness bound. */
  FEED_STALE: 'feed_stale',
  /** The deployment does not serve the revocation feed, or it is not ready. */
  FEED_UNAVAILABLE: 'feed_unavailable',
  /** An online revocation check could not be completed. */
  STATUS_UNAVAILABLE: 'status_unavailable',
} as const;

export type RevocationSubReason = (typeof RevocationSubReason)[keyof typeof RevocationSubReason];

/** Sub-reasons for `token_invalid`. */
export const TokenSubReason = {
  /** The `authorization_details` claim cannot be read unambiguously. */
  MALFORMED_AUTHORIZATION_DETAILS: 'malformed_authorization_details',
} as const;

/**
 * Sub-reasons for `decision_required` and `decision_invalid` (PRD G-3;
 * `spec/decision-grant.md`). The first four are PRD Appendix B's; the auth
 * service and the Python SDK use the same values.
 */
export const DecisionSubReason = {
  /** The grant approves a different action (tool, decision, subject, amount or connector). */
  ACTION_MISMATCH: 'action_mismatch',
  /** The grant is past its expiry. */
  EXPIRED: 'expired',
  /** The grant has already been used. */
  CONSUMED: 'consumed',
  /** Both grants of a four-eyes decision name the same approver. */
  SAME_APPROVER: 'same_approver',
  /** The case changed (new case version) after the decision was approved. */
  CASE_CHANGED: 'case_changed',
  /** The grant approves an action on another case. */
  WRONG_CASE: 'wrong_case',
  /** The approver's authentication was not step-up (auth service only). */
  STEP_UP_REQUIRED: 'step_up_required',
  /** The decision request was cancelled and its grants revoked. */
  REVOKED: 'revoked',
  /** The issuer does not know the grant, or it belongs to another developer. */
  UNKNOWN_GRANT: 'unknown_grant',
  /** The grant, or the action to compare it with, cannot be read. */
  MALFORMED: 'malformed',
  /** The decision needs two approvals and fewer were presented. */
  FOUR_EYES_INCOMPLETE: 'four_eyes_incomplete',
  /** The grant could not be consumed at the issuer (network, server or configuration). */
  CONSUME_UNAVAILABLE: 'consume_unavailable',
  /** No decision grant was presented (reported as `decision_required`). */
  ABSENT: 'absent',
} as const;
export type DecisionSubReason = (typeof DecisionSubReason)[keyof typeof DecisionSubReason];
