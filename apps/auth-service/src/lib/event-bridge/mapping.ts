/**
 * Declarative mapping rules (PRD G-6): from an event type and a subject
 * matcher to one action on the grants the subject resolves to.
 *
 * A rule is data, not code: an event type (exact or a trailing `*`), optional
 * conditions over paths inside the event, a target that says which grants the
 * event is about, and one action — `suspend`, `revoke` or `re_evaluate`.
 * Rules belong to one developer and only ever resolve that developer's grants.
 *
 * Matching is deliberately small. Anything a rule cannot evaluate
 * unambiguously (a path that is not a string, a target the event does not
 * carry) is recorded as `target_invalid` and acted on by nothing.
 */
import { isPlainObject, type NormalizedEvent } from './normalize.js';

export const RULE_ACTIONS = ['suspend', 'revoke', 're_evaluate'] as const;
export const RULE_MODES = ['enforce', 'observe'] as const;
export const RULE_STATUSES = ['active', 'disabled'] as const;
export const TARGET_KINDS = ['grant_id', 'principal_id', 'agent_id', 'subject_ref'] as const;

export type RuleAction = (typeof RULE_ACTIONS)[number];
export type RuleMode = (typeof RULE_MODES)[number];
export type RuleStatus = (typeof RULE_STATUSES)[number];
export type TargetBy = (typeof TARGET_KINDS)[number];

export type Scalar = string | number | boolean | null;

export interface RuleCondition {
  path: string;
  equals?: Scalar;
  in?: Scalar[];
  exists?: boolean;
}

export interface RuleTarget {
  by: TargetBy;
  /** Path in the event holding the identifier (or a list of them). */
  path: string;
  /** Binding kind for `subject_ref` targets (`grant_subject_refs.kind`). */
  kind?: string;
}

export interface MappingRule {
  id: string;
  developerId: string;
  name: string;
  sourceId: string | null;
  eventType: string;
  conditions: RuleCondition[];
  target: RuleTarget;
  action: RuleAction;
  mode: RuleMode;
  status: RuleStatus;
}

export const MAX_CONDITIONS = 10;
export const MAX_IN_VALUES = 50;
export const MAX_TARGET_VALUES = 50;
export const MAX_RULES_PER_DEVELOPER = 200;
const PATH = /^(type|subject|data)(\.[A-Za-z0-9_:-]{1,64}){0,8}$/;
const REF_KIND = /^[a-z][a-z0-9_.:-]{0,63}$/;
const EVENT_TYPE = /^[\x21-\x7e]{1,512}$/;

/** Read a dotted path out of the normalised event. Returns undefined for anything absent. */
export function readEventPath(event: NormalizedEvent, path: string): unknown {
  const [head, ...rest] = path.split('.');
  let current: unknown =
    head === 'type' ? event.type : head === 'subject' ? event.subject : head === 'data' ? event.data : undefined;
  for (const segment of rest) {
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : -1;
      current = index >= 0 && index < current.length ? current[index] : undefined;
    } else if (isPlainObject(current)) {
      current = Object.prototype.hasOwnProperty.call(current, segment)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function isScalar(value: unknown): value is Scalar {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function eventTypeMatches(pattern: string, type: string): boolean {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

function conditionHolds(condition: RuleCondition, event: NormalizedEvent): boolean {
  const value = readEventPath(event, condition.path);
  if (condition.exists !== undefined) return (value !== undefined) === condition.exists;
  if (value === undefined) return false;
  if (condition.in !== undefined) return isScalar(value) && condition.in.some((candidate) => candidate === value);
  return isScalar(value) && value === condition.equals;
}

/** Does this rule apply to this event? Source, type and every condition must match. */
export function ruleMatchesEvent(rule: MappingRule, event: NormalizedEvent): boolean {
  if (rule.status !== 'active') return false;
  if (rule.sourceId !== null && rule.sourceId !== event.sourceId) return false;
  if (!eventTypeMatches(rule.eventType, event.type)) return false;
  return rule.conditions.every((condition) => conditionHolds(condition, event));
}

/**
 * The identifiers a matched rule points at: one string, or a list of them.
 * `null` means the event does not carry a usable identifier at that path —
 * the rule acts on nothing and the delivery records `target_invalid`.
 */
export function targetValues(rule: MappingRule, event: NormalizedEvent): string[] | null {
  const value = readEventPath(event, rule.target.path);
  const candidates = Array.isArray(value) ? value : [value];
  if (candidates.length === 0 || candidates.length > MAX_TARGET_VALUES) return null;
  const values: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) return null;
    values.push(candidate);
  }
  return [...new Set(values)];
}

// ── Validation of rules supplied by a developer ─────────────────────────────

export class RuleValidationError extends Error {
  readonly fields: Record<string, string>;

  constructor(fields: Record<string, string>) {
    super('Request validation failed');
    this.name = 'RuleValidationError';
    this.fields = fields;
  }
}

export interface RuleInput {
  name: string;
  sourceId: string | null;
  eventType: string;
  conditions: RuleCondition[];
  target: RuleTarget;
  action: RuleAction;
  mode: RuleMode;
  status: RuleStatus;
}

const CREATE_FIELDS = new Set(['name', 'sourceId', 'eventType', 'conditions', 'target', 'action', 'mode', 'status']);

function parseConditions(value: unknown, errors: Record<string, string>): RuleCondition[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CONDITIONS) {
    errors['conditions'] = `must be an array of at most ${MAX_CONDITIONS} conditions`;
    return undefined;
  }
  const conditions: RuleCondition[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry['path'] !== 'string' || !PATH.test(entry['path'])) {
      errors['conditions'] = 'each condition needs a path like subject.business_ref or data.status';
      return undefined;
    }
    const keys = Object.keys(entry).filter((key) => key !== 'path');
    if (keys.length !== 1 || !['equals', 'in', 'exists'].includes(keys[0]!)) {
      errors['conditions'] = 'each condition needs exactly one of equals, in or exists';
      return undefined;
    }
    const condition: RuleCondition = { path: entry['path'] };
    if (keys[0] === 'equals') {
      if (!isScalar(entry['equals'])) {
        errors['conditions'] = 'equals must be a string, number, boolean or null';
        return undefined;
      }
      condition.equals = entry['equals'];
    } else if (keys[0] === 'in') {
      const list = entry['in'];
      if (!Array.isArray(list) || list.length === 0 || list.length > MAX_IN_VALUES || !list.every(isScalar)) {
        errors['conditions'] = `in must be 1 to ${MAX_IN_VALUES} scalar values`;
        return undefined;
      }
      condition.in = list as Scalar[];
    } else {
      if (typeof entry['exists'] !== 'boolean') {
        errors['conditions'] = 'exists must be a boolean';
        return undefined;
      }
      condition.exists = entry['exists'];
    }
    conditions.push(condition);
  }
  return conditions;
}

function parseTarget(value: unknown, errors: Record<string, string>): RuleTarget | undefined {
  if (!isPlainObject(value)) {
    errors['target'] = 'must be an object';
    return undefined;
  }
  const extra = Object.keys(value).filter((key) => !['by', 'path', 'kind'].includes(key));
  if (extra.length > 0) {
    errors['target'] = `unknown member${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`;
    return undefined;
  }
  const by = value['by'];
  if (typeof by !== 'string' || !(TARGET_KINDS as readonly string[]).includes(by)) {
    errors['target'] = `by must be one of ${TARGET_KINDS.join(', ')}`;
    return undefined;
  }
  const path = value['path'];
  if (typeof path !== 'string' || !PATH.test(path)) {
    errors['target'] = 'path must name a member of the event, like subject.business_ref';
    return undefined;
  }
  const target: RuleTarget = { by: by as TargetBy, path };
  if (by === 'subject_ref') {
    const kind = value['kind'];
    if (typeof kind !== 'string' || !REF_KIND.test(kind)) {
      errors['target'] = 'kind is required for subject_ref targets (lower-case, at most 64 characters)';
      return undefined;
    }
    target.kind = kind;
  } else if (value['kind'] !== undefined) {
    errors['target'] = 'kind applies only to subject_ref targets';
    return undefined;
  }
  return target;
}

/**
 * Validate a rule as supplied by a developer. `existing` is the rule being
 * patched, if any; members it does not name keep their current value.
 */
export function parseRuleInput(body: unknown, existing?: MappingRule): RuleInput {
  if (!isPlainObject(body)) throw new RuleValidationError({ body: 'must be a JSON object' });
  const errors: Record<string, string> = {};
  const unknown = Object.keys(body).filter((key) => !CREATE_FIELDS.has(key));
  if (unknown.length > 0) {
    errors['body'] = `unknown field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`;
  }

  const name = body['name'] === undefined ? existing?.name : body['name'];
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 128) {
    errors['name'] = 'must be a non-empty string of at most 128 characters';
  }

  let sourceId: string | null | undefined = existing ? existing.sourceId : null;
  if (body['sourceId'] !== undefined) {
    if (body['sourceId'] === null) {
      sourceId = null;
    } else if (typeof body['sourceId'] === 'string' && body['sourceId'].length <= 64) {
      sourceId = body['sourceId'];
    } else {
      errors['sourceId'] = 'must be an event source id or null for any source';
    }
  }

  const eventType = body['eventType'] === undefined ? existing?.eventType : body['eventType'];
  if (typeof eventType !== 'string' || !EVENT_TYPE.test(eventType)) {
    errors['eventType'] = 'must be an event type, optionally ending in * to match a prefix';
  }

  const conditions = body['conditions'] === undefined
    ? (existing?.conditions ?? [])
    : parseConditions(body['conditions'], errors);
  const target = body['target'] === undefined
    ? existing?.target
    : parseTarget(body['target'], errors);
  if (target === undefined && errors['target'] === undefined) errors['target'] = 'required';

  const action = body['action'] === undefined ? existing?.action : body['action'];
  if (typeof action !== 'string' || !(RULE_ACTIONS as readonly string[]).includes(action)) {
    errors['action'] = `must be one of ${RULE_ACTIONS.join(', ')}`;
  }
  const mode = body['mode'] === undefined ? (existing?.mode ?? 'enforce') : body['mode'];
  if (typeof mode !== 'string' || !(RULE_MODES as readonly string[]).includes(mode)) {
    errors['mode'] = `must be one of ${RULE_MODES.join(', ')}`;
  }
  const status = body['status'] === undefined ? (existing?.status ?? 'active') : body['status'];
  if (typeof status !== 'string' || !(RULE_STATUSES as readonly string[]).includes(status)) {
    errors['status'] = `must be one of ${RULE_STATUSES.join(', ')}`;
  }

  if (Object.keys(errors).length > 0) throw new RuleValidationError(errors);
  return {
    name: name as string,
    sourceId: sourceId ?? null,
    eventType: eventType as string,
    conditions: conditions as RuleCondition[],
    target: target as RuleTarget,
    action: action as RuleAction,
    mode: mode as RuleMode,
    status: status as RuleStatus,
  };
}
