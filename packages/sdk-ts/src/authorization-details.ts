/**
 * Read `urn:grantex:tools:v1` entries from a grant's `authorization_details`.
 *
 * This is the only place that interprets the `authorization_details` claim
 * (RFC 9396), so a change to the token format touches one function. Shape:
 *
 * ```json
 * "authorization_details": [{
 *   "type": "urn:grantex:tools:v1",
 *   "connector": "acme_kyb",
 *   "purpose": "aml.cdd.onboarding",
 *   "data_region": "eu",
 *   "tools": ["resolve_business", "verify_business", "screen_*"],
 *   "caps": {"verify_business": {"per_hour": 50, "per_case": 3},
 *            "cost_units": {"per_day": 5000}}
 * }]
 * ```
 *
 * Entries of other types are separate authorizations and are ignored here. A
 * tools entry constrains calls on its connector in addition to the grant's
 * scopes. Anything ambiguous (a claim that is not an array, an entry without
 * a string `type`, a tools entry with an unknown key, a value of the wrong
 * type, or two tools entries for one connector) throws
 * `AuthorizationDetailsError`, and `enforce()` denies. Mirrors the Python
 * SDK's `grantex._authorization_details`.
 *
 * `caps` is validated here, for every call on the connector: each key is an
 * exact tool name or `cost_units` (the connector's cost-unit budget), never a
 * wildcard, and each value is a non-empty object of `per_hour`, `per_day` and
 * `per_case` counts from 0 to 2147483647.
 */

export const TOOLS_DETAIL_TYPE = 'urn:grantex:tools:v1';

const ENTRY_KEYS = new Set(['type', 'connector', 'purpose', 'data_region', 'tools', 'caps']);
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const TOOL_PATTERN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}\*?$/;
const CAP_WINDOWS = ['per_hour', 'per_day', 'per_case'] as const;
const MAX_COUNT = 2147483647;

/** Key of the connector cost-unit budget in `caps`; reserved as a tool name. */
export const COST_UNITS_KEY = 'cost_units';

export type CapWindowCounts = Partial<Record<(typeof CAP_WINDOWS)[number], number>>;

export class AuthorizationDetailsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizationDetailsError';
  }
}

/** One `urn:grantex:tools:v1` entry. */
export interface ToolsAuthorization {
  connector: string;
  /** The grant's purpose for this connector, exactly as issued (not validated). */
  purpose?: string;
  dataRegion?: string;
  /** Tool names, or prefixes ending in `*`; absent means every tool. */
  tools?: readonly string[];
  /** Validated caps: tool name (or `cost_units`) to window to count. */
  caps?: Readonly<Record<string, Readonly<CapWindowCounts>>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCaps(raw: unknown, where: string): Record<string, CapWindowCounts> {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new AuthorizationDetailsError(`${where} must be a non-empty object`);
  }
  const parsed: Record<string, CapWindowCounts> = {};
  for (const [name, windows] of Object.entries(raw)) {
    if (!(name === COST_UNITS_KEY || NAME_RE.test(name))) {
      throw new AuthorizationDetailsError(
        `${where} key "${name}" must be an exact tool name or cost_units; wildcards are not allowed`,
      );
    }
    if (!isPlainObject(windows) || Object.keys(windows).length === 0) {
      throw new AuthorizationDetailsError(`${where}.${name} must be a non-empty object`);
    }
    const counts: CapWindowCounts = {};
    for (const [window, value] of Object.entries(windows)) {
      if (!(CAP_WINDOWS as readonly string[]).includes(window)) {
        throw new AuthorizationDetailsError(`${where}.${name} has unknown window "${window}"`);
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
        throw new AuthorizationDetailsError(`${where}.${name}.${window} must be an integer between 0 and ${MAX_COUNT}`);
      }
      counts[window as (typeof CAP_WINDOWS)[number]] = value;
    }
    Object.defineProperty(parsed, name, { value: Object.freeze(counts), enumerable: true, writable: false, configurable: false });
  }
  return parsed;
}

/** Whether an entry's `tools` list (when present) names `tool`. */
export function toolsAuthorizationAllows(entry: ToolsAuthorization, tool: string): boolean {
  if (entry.tools === undefined) return true;
  return entry.tools.some((t) => (t.endsWith('*') ? tool.startsWith(t.slice(0, -1)) : t === tool));
}

/**
 * Return the tools entries of an `authorization_details` claim by connector.
 * `undefined` or `null` (no claim) yields an empty map.
 *
 * @throws {AuthorizationDetailsError} the claim is malformed or ambiguous.
 */
export function parseToolsAuthorization(claim: unknown): Map<string, ToolsAuthorization> {
  const entries = new Map<string, ToolsAuthorization>();
  if (claim === undefined || claim === null) return entries;
  if (!Array.isArray(claim)) throw new AuthorizationDetailsError('authorization_details must be an array');

  claim.forEach((raw: unknown, index) => {
    const where = `authorization_details[${index}]`;
    if (!isPlainObject(raw)) throw new AuthorizationDetailsError(`${where} must be an object`);
    const type = raw['type'];
    if (typeof type !== 'string' || type.length === 0) {
      throw new AuthorizationDetailsError(`${where}.type must be a non-empty string`);
    }
    if (type !== TOOLS_DETAIL_TYPE) return;

    const unknown = Object.keys(raw).filter((k) => !ENTRY_KEYS.has(k)).sort();
    if (unknown.length > 0) throw new AuthorizationDetailsError(`${where} has unknown key "${unknown[0]}"`);

    const connector = raw['connector'];
    if (typeof connector !== 'string' || !NAME_RE.test(connector)) {
      throw new AuthorizationDetailsError(`${where}.connector must be a connector name`);
    }
    if (entries.has(connector)) {
      throw new AuthorizationDetailsError(
        `${where} repeats connector "${connector}"; a grant carries one tools entry per connector`,
      );
    }

    const entry: ToolsAuthorization = { connector };
    const purpose = raw['purpose'];
    if (purpose !== undefined && purpose !== null) {
      if (typeof purpose !== 'string') throw new AuthorizationDetailsError(`${where}.purpose must be a string`);
      entry.purpose = purpose;
    }
    const dataRegion = raw['data_region'];
    if (dataRegion !== undefined && dataRegion !== null) {
      if (typeof dataRegion !== 'string') throw new AuthorizationDetailsError(`${where}.data_region must be a string`);
      entry.dataRegion = dataRegion;
    }
    if ('tools' in raw) {
      const tools = raw['tools'];
      if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && TOOL_PATTERN_RE.test(t))) {
        throw new AuthorizationDetailsError(`${where}.tools must be an array of tool names or name prefixes ending in *`);
      }
      entry.tools = Object.freeze([...(tools as string[])]);
    }
    if ('caps' in raw) {
      entry.caps = Object.freeze(parseCaps(raw['caps'], `${where}.caps`));
    }
    entries.set(connector, entry);
  });
  return entries;
}
