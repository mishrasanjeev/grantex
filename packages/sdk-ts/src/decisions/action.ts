/**
 * The semantic action a decision grant approves, and its hash (PRD G-3).
 *
 * A decision grant is bound to what a person approved, not to the bytes of a
 * tool call: `{case_id, action, decision, subject, amount?}`, hashed as
 *
 *     action_hash = "sha256:" + base64url(SHA-256(JCS(action)))
 *
 * with RFC 8785 canonical JSON (`canonical.ts`) and unpadded base64url.
 * Re-planning the tool payload, adding a timestamp or reordering fields leaves
 * the hash unchanged; changing any of the five fields changes it. The Python
 * SDK (`grantex.decisions`) implements the same rules.
 */
import { createHash } from 'node:crypto';
import { canonicalize } from '../canonical.js';

export const ACTION_HASH_PREFIX = 'sha256:';
export const ACTION_FIELDS = ['case_id', 'action', 'decision', 'subject', 'amount'] as const;
const REQUIRED_FIELDS = ['case_id', 'action', 'decision', 'subject'] as const;

const TOOL_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DECISION_RE = /^[a-z][a-z0-9_]{0,63}$/;
const DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const HASH_RE = /^sha256:[A-Za-z0-9_-]{43}$/;

export const MAX_CASE_ID_LENGTH = 256;
export const MAX_SUBJECT_LENGTH = 512;
const MAX_AMOUNT_LENGTH = 64;

/** The JSON object form of a semantic action (the decision grant's `action` claim). */
export interface DecisionAction {
  case_id: string;
  /** The manifest tool that carries out the decision, e.g. `case_decision`. */
  action: string;
  /** The outcome approved, e.g. `approve` or `decline`. */
  decision: string;
  /** What the decision is about, e.g. `gb:00000001`. */
  subject: string;
  /** A finite number or a canonical decimal string. A number and a string are different values. */
  amount?: number | string;
}

export type ActionValidationCode =
  | 'not_an_object'
  | 'missing_field'
  | 'unknown_field'
  | 'invalid_type'
  | 'invalid_value';

/** The semantic action is malformed. `code` and `field` match the Python SDK. */
export class ActionValidationError extends Error {
  readonly code: ActionValidationCode;
  readonly field: string;
  constructor(code: ActionValidationCode, field: string, message: string) {
    super(message);
    this.name = 'ActionValidationError';
    this.code = code;
    this.field = field;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Validates the JSON object form and returns a normalised copy, refusing
 * unknown or missing fields. `amount` may be absent; `"amount": null` is
 * refused, so a field has one encoding.
 */
export function parseDecisionAction(value: unknown): DecisionAction {
  if (!isRecord(value)) {
    throw new ActionValidationError('not_an_object', '', 'action: must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!(ACTION_FIELDS as readonly string[]).includes(key)) {
      throw new ActionValidationError('unknown_field', key, `action: unknown field '${key}'`);
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!has(value, key)) {
      throw new ActionValidationError('missing_field', key, `action: missing field '${key}'`);
    }
  }
  if (has(value, 'amount') && (value['amount'] === null || value['amount'] === undefined)) {
    throw new ActionValidationError('invalid_type', 'amount', 'amount: omit the field instead of sending null');
  }
  return build(value['case_id'], value['action'], value['decision'], value['subject'], value['amount']);
}

/**
 * Derives the semantic action from a tool call: `action` is the tool name;
 * `case_id`, `decision`, `subject` and (when present and not null) `amount`
 * are read from the arguments. Every other argument is ignored.
 */
export function decisionActionFromToolCall(tool: string, args: unknown): DecisionAction {
  if (!isRecord(args)) {
    throw new ActionValidationError('not_an_object', '', 'tool arguments: must be a JSON object');
  }
  for (const key of ['case_id', 'decision', 'subject']) {
    if (!has(args, key)) {
      throw new ActionValidationError('missing_field', key, `tool arguments: missing '${key}'`);
    }
  }
  const amount = has(args, 'amount') ? args['amount'] : undefined;
  return build(args['case_id'], tool, args['decision'], args['subject'], amount === null ? undefined : amount);
}

/** RFC 8785 canonical JSON of the action. */
export function canonicalActionJson(action: DecisionAction): string {
  const normalised = parseDecisionAction(action);
  return canonicalize(normalised);
}

/** `sha256:` followed by the unpadded base64url SHA-256 of the canonical JSON. */
export function computeActionHash(action: DecisionAction | Record<string, unknown>): string {
  const canonical = canonicalActionJson(action as DecisionAction);
  return ACTION_HASH_PREFIX + createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/** Whether `value` has the shape of an `action_hash`. */
export function isActionHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function build(caseId: unknown, action: unknown, decision: unknown, subject: unknown, amount: unknown): DecisionAction {
  validateString('case_id', caseId, MAX_CASE_ID_LENGTH);
  validateString('action', action, 128);
  if (!TOOL_NAME_RE.test(action)) {
    throw new ActionValidationError('invalid_value', 'action', 'action: must be a manifest tool name');
  }
  validateString('decision', decision, 64);
  if (!DECISION_RE.test(decision)) {
    throw new ActionValidationError('invalid_value', 'decision', 'decision: must match ^[a-z][a-z0-9_]{0,63}$');
  }
  validateString('subject', subject, MAX_SUBJECT_LENGTH);
  const out: DecisionAction = { case_id: caseId, action, decision, subject };
  if (amount !== undefined) {
    validateAmount(amount);
    out.amount = amount;
  }
  return out;
}

function validateString(field: string, value: unknown, maxLength: number): asserts value is string {
  if (typeof value !== 'string') {
    throw new ActionValidationError('invalid_type', field, `${field}: must be a string`);
  }
  // Lengths count Unicode code points, the same in every SDK. A lone
  // surrogate counts as one code point here and is refused below.
  let length = 0;
  for (const _ of value) length++;
  if (length === 0 || length > maxLength) {
    throw new ActionValidationError('invalid_value', field, `${field}: must be 1-${maxLength} code points`);
  }
  if (CONTROL_RE.test(value) || LONE_SURROGATE.test(value)) {
    throw new ActionValidationError(
      'invalid_value',
      field,
      `${field}: must not contain control characters or unpaired surrogates`,
    );
  }
}

function validateAmount(value: unknown): asserts value is number | string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ActionValidationError('invalid_value', 'amount', 'amount: must be a finite number');
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_AMOUNT_LENGTH || !DECIMAL_RE.test(value) || value === '-0') {
      throw new ActionValidationError(
        'invalid_value',
        'amount',
        "amount: decimal strings must be canonical (no leading zeros, trailing fractional zeros, '+', '-0' or exponent)",
      );
    }
    return;
  }
  throw new ActionValidationError('invalid_type', 'amount', 'amount: must be a number or a decimal string');
}
