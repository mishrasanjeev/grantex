/**
 * Decision references in a grant token's `authorization_details` (RFC 9396),
 * entries of type `urn:grantex:decision:v1` (`spec/grant-token-0.6.md`):
 *
 * ```json
 * {"type": "urn:grantex:decision:v1", "connector": "acme_kyb",
 *  "tools": ["case_decision"], "four_eyes_on": {"case_decision": ["decline"]}}
 * ```
 *
 * A tool listed in the entry for its connector needs a decision grant even
 * when the manifest does not declare `requires_decision`, and a decision in
 * the entry's `four_eyes_on` needs two approvers. The rules match the SDKs'
 * `parseDecisionReferences`: an entry that cannot be read unambiguously is an
 * error, and the guard refuses the call.
 */
import type { ToolRequirement } from './tool-policy.js';

export const DECISION_DETAIL_TYPE = 'urn:grantex:decision:v1';

const ENTRY_KEYS = new Set(['type', 'connector', 'tools', 'four_eyes_on']);
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DECISION_RE = /^[a-z][a-z0-9_]{0,63}$/;

export class DecisionReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionReferenceError';
  }
}

export interface DecisionReference {
  connector: string;
  tools: readonly string[];
  fourEyesOn: Readonly<Record<string, readonly string[]>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The decision reference for `connector` in an `authorization_details` claim,
 * or `undefined` when there is none. Throws {@link DecisionReferenceError} when
 * the claim or any decision entry is malformed, or a connector has two entries.
 */
export function decisionReferenceFor(claim: unknown, connector: string): DecisionReference | undefined {
  if (claim === undefined || claim === null) return undefined;
  if (!Array.isArray(claim)) throw new DecisionReferenceError('authorization_details must be an array');
  let found: DecisionReference | undefined;
  const seen = new Set<string>();
  claim.forEach((raw: unknown, index) => {
    const where = `authorization_details[${index}]`;
    if (!isPlainObject(raw)) throw new DecisionReferenceError(`${where} must be an object`);
    const type = raw['type'];
    if (typeof type !== 'string' || type.length === 0) throw new DecisionReferenceError(`${where}.type must be a non-empty string`);
    if (type !== DECISION_DETAIL_TYPE) return;
    const unknown = Object.keys(raw).filter((k) => !ENTRY_KEYS.has(k)).sort();
    if (unknown.length > 0) throw new DecisionReferenceError(`${where} has unknown key "${unknown[0]}"`);
    const entryConnector = raw['connector'];
    if (typeof entryConnector !== 'string' || !NAME_RE.test(entryConnector)) {
      throw new DecisionReferenceError(`${where}.connector must be a connector name`);
    }
    if (seen.has(entryConnector)) throw new DecisionReferenceError(`${where} repeats connector "${entryConnector}"`);
    seen.add(entryConnector);
    const tools = raw['tools'];
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === 'string' && NAME_RE.test(t))) {
      throw new DecisionReferenceError(`${where}.tools must be a non-empty array of tool names`);
    }
    const fourEyesOn: Record<string, readonly string[]> = {};
    if ('four_eyes_on' in raw) {
      const rawFourEyes = raw['four_eyes_on'];
      if (!isPlainObject(rawFourEyes)) throw new DecisionReferenceError(`${where}.four_eyes_on must be an object`);
      for (const [tool, decisions] of Object.entries(rawFourEyes)) {
        if (!(tools as string[]).includes(tool)) {
          throw new DecisionReferenceError(`${where}.four_eyes_on names "${tool}", which is not in tools`);
        }
        if (!Array.isArray(decisions) || decisions.length === 0 || !decisions.every((d) => typeof d === 'string' && DECISION_RE.test(d))) {
          throw new DecisionReferenceError(`${where}.four_eyes_on.${tool} must be a non-empty array of decisions`);
        }
        fourEyesOn[tool] = [...(decisions as string[])];
      }
    }
    if (entryConnector === connector) found = { connector, tools: [...(tools as string[])], fourEyesOn };
  });
  return found;
}

/**
 * The requirement for a call with the grant's decision reference applied:
 * `requiresDecision` when the manifest or the reference says so, and
 * `fourEyesOn` the union of both. Throws {@link DecisionReferenceError} for a
 * malformed claim.
 */
export function withGrantDecisionReference(requirement: ToolRequirement, authorizationDetails: unknown): ToolRequirement {
  if (requirement.connector === undefined) {
    // No connector to match an entry against; still refuse a malformed claim.
    decisionReferenceFor(authorizationDetails, '');
    return requirement;
  }
  const reference = decisionReferenceFor(authorizationDetails, requirement.connector);
  if (reference === undefined || !reference.tools.includes(requirement.tool)) return requirement;
  const fourEyesOn = [...new Set([...(requirement.fourEyesOn ?? []), ...(reference.fourEyesOn[requirement.tool] ?? [])])];
  return { ...requirement, requiresDecision: true, ...(fourEyesOn.length > 0 ? { fourEyesOn } : {}) };
}
