/**
 * Tool Manifest & Permission — scope enforcement for AI agent tool calls.
 *
 * A ToolManifest declares the permission level (read/write/delete/admin)
 * required for each tool on a connector. The `enforce()` method on the
 * Grantex client uses loaded manifests to check whether a grant token's
 * scopes allow a given tool call.
 *
 * @example
 * ```ts
 * import { ToolManifest, Permission } from '@grantex/sdk';
 *
 * const manifest = new ToolManifest({
 *   connector: 'salesforce',
 *   tools: {
 *     query: Permission.READ,
 *     create_lead: Permission.WRITE,
 *     delete_contact: Permission.DELETE,
 *   },
 * });
 * ```
 */

import type { DenialReason } from './denials.js';
import type { CapLimit, CapsMode, Reservation } from './caps/meter.js';

/* ------------------------------------------------------------------ */
/*  Permission                                                         */
/* ------------------------------------------------------------------ */

/** Permission levels for tool operations. */
export enum Permission {
  READ = 'read',
  WRITE = 'write',
  DELETE = 'delete',
  ADMIN = 'admin',
}

const PERMISSION_LEVELS: Record<Permission, number> = {
  [Permission.READ]: 0,
  [Permission.WRITE]: 1,
  [Permission.DELETE]: 2,
  [Permission.ADMIN]: 3,
};

/**
 * Check whether a granted permission level covers the required level.
 *
 * Hierarchy: `admin > delete > write > read`
 *
 * - A `write` scope covers `read` + `write` tools.
 * - A `delete` scope covers `read` + `write` + `delete` tools.
 * - An `admin` scope covers everything.
 */
export function permissionCovers(granted: string, required: string): boolean {
  const grantedLevel = PERMISSION_LEVELS[granted as Permission] ?? -1;
  const requiredLevel = PERMISSION_LEVELS[required as Permission] ?? 99;
  return grantedLevel >= requiredLevel;
}

/* ------------------------------------------------------------------ */
/*  Manifest 0.6 tool declarations                                     */
/* ------------------------------------------------------------------ */

/** `$id` of the manifest 0.6 JSON Schema. */
export const MANIFEST_SCHEMA_ID = 'https://grantex.dev/spec/manifest-0.6.schema.json';

/** Largest cap or cost-unit value a manifest may declare. */
export const MAX_COUNT = 2147483647;

/** Not allowed as a tool name: grant `caps` use it for the cost-unit budget. */
export const RESERVED_TOOL_NAME = 'cost_units';

const TOP_LEVEL_KEYS = ['$schema', 'connector', 'version', 'description', 'tools'] as const;
const TOOL_KEYS = [
  'permission',
  'allowed_purposes',
  'caps',
  'cost_units',
  'requires_decision',
  'four_eyes_on',
] as const;
const CAP_KEYS = ['per_hour', 'per_day', 'per_case'] as const;

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const UNIT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SEG = '[a-z][a-z0-9_]*';
const ORG = 'x-[a-z0-9]+(?:-[a-z0-9]+)*';
/** Syntax of an `allowed_purposes` entry (a purpose or a `prefix.*` wildcard). */
export const PURPOSE_PATTERN_RE = new RegExp(
  `^(?:${SEG}(?:\\.${SEG})*(?:\\.\\*)?|${ORG}(?:(?:\\.${SEG})+(?:\\.\\*)?|\\.\\*))$`,
);
const MAX_PURPOSE_LENGTH = 128;

/** A manifest does not conform to manifest schema 0.6. The message names the offending path. */
export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

/** Call caps as written in a manifest. */
export interface ManifestToolCaps {
  per_hour?: number;
  per_day?: number;
  per_case?: number;
}

/** The object form of a tool declaration, exactly as written in a manifest file. */
export interface ManifestToolObject {
  permission: Permission | `${Permission}`;
  allowed_purposes?: string[];
  caps?: ManifestToolCaps;
  cost_units?: Record<string, number>;
  requires_decision?: boolean;
  four_eyes_on?: string[];
}

/** A tool value: a permission string or a manifest 0.6 object. */
export type ToolDeclaration = Permission | `${Permission}` | ManifestToolObject;

/** Call caps declared for a tool. Absent means no cap of that kind; `0` disables the tool. */
export interface ToolCaps {
  /** Rolling one-hour window. */
  perHour?: number;
  /** Rolling one-day window. */
  perDay?: number;
  /** Calls within one case. */
  perCase?: number;
}

/** A tool's full, validated declaration. */
export interface ToolSpec {
  permission: Permission;
  /** Purpose patterns; absent means no purpose restriction. */
  allowedPurposes?: readonly string[];
  caps?: ToolCaps;
  costUnits?: Readonly<Record<string, number>>;
  requiresDecision: boolean;
  fourEyesOn: readonly string[];
}

function q(value: unknown): string {
  const out = JSON.stringify(value);
  return out === undefined ? String(value) : out;
}

function fail(message: string): ManifestValidationError {
  return new ManifestValidationError(`ToolManifest: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (Object.values(Permission) as string[]).includes(value);
}

function invalidPermission(value: unknown, tool: string): ManifestValidationError {
  return fail(
    `invalid permission ${q(value)} for tool ${q(tool)}. Must be one of: ${Object.values(Permission).join(', ')}`,
  );
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
    throw fail(`${path}: must be an integer between 0 and ${MAX_COUNT}`);
  }
  return value;
}

/** Whether `value` is a syntactically valid `allowed_purposes` entry. */
export function isValidPurposePattern(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_PURPOSE_LENGTH && PURPOSE_PATTERN_RE.test(value)
  );
}

function checkNames(connector: unknown, tools: Record<string, unknown>): void {
  if (typeof connector !== 'string' || !NAME_RE.test(connector)) {
    throw fail(`invalid connector name ${q(connector)}`);
  }
  for (const name of Object.keys(tools)) {
    if (!NAME_RE.test(name)) throw fail(`invalid tool name ${q(name)}`);
  }
}

/**
 * Validate one tool value (string or object form) and return its ToolSpec.
 *
 * @throws {ManifestValidationError} the value does not conform to manifest 0.6.
 */
export function parseToolDeclaration(tool: string, value: unknown): ToolSpec {
  if (tool === RESERVED_TOOL_NAME) {
    throw fail(`tool name ${q(tool)} is reserved: it names the cost-unit budget in grant caps`);
  }
  if (typeof value === 'string') {
    if (!isPermission(value)) throw invalidPermission(value, tool);
    return { permission: value, requiresDecision: false, fourEyesOn: [] };
  }
  if (!isPlainObject(value)) {
    throw fail(`tools.${tool}: must be a permission string or an object`);
  }

  const path = `tools.${tool}`;
  for (const key of Object.keys(value)) {
    if (!(TOOL_KEYS as readonly string[]).includes(key)) {
      throw fail(`${path}: unknown key ${q(key)} (allowed: ${TOOL_KEYS.join(', ')})`);
    }
  }
  if (!('permission' in value)) throw fail(`${path}: missing required key "permission"`);
  const permission = value['permission'];
  if (!isPermission(permission)) throw invalidPermission(permission, tool);

  const spec: ToolSpec = { permission, requiresDecision: false, fourEyesOn: [] };

  if ('allowed_purposes' in value) {
    const raw = value['allowed_purposes'];
    const message = `${path}.allowed_purposes: must be a non-empty array of unique purpose patterns`;
    if (!Array.isArray(raw) || raw.length === 0) throw fail(message);
    raw.forEach((pattern, index) => {
      if (!isValidPurposePattern(pattern)) {
        throw fail(`${path}.allowed_purposes[${index}]: invalid purpose pattern ${q(pattern)}`);
      }
    });
    if (new Set(raw).size !== raw.length) throw fail(message);
    spec.allowedPurposes = Object.freeze([...(raw as string[])]);
  }

  if ('caps' in value) {
    const raw = value['caps'];
    if (!isPlainObject(raw)) throw fail(`${path}.caps: must be an object`);
    for (const key of Object.keys(raw)) {
      if (!(CAP_KEYS as readonly string[]).includes(key)) {
        throw fail(`${path}.caps: unknown key ${q(key)} (allowed: ${CAP_KEYS.join(', ')})`);
      }
    }
    if (Object.keys(raw).length === 0) {
      throw fail(`${path}.caps: must declare at least one of ${CAP_KEYS.join(', ')}`);
    }
    const caps: ToolCaps = {};
    if ('per_hour' in raw) caps.perHour = count(raw['per_hour'], `${path}.caps.per_hour`);
    if ('per_day' in raw) caps.perDay = count(raw['per_day'], `${path}.caps.per_day`);
    if ('per_case' in raw) caps.perCase = count(raw['per_case'], `${path}.caps.per_case`);
    spec.caps = Object.freeze(caps);
  }

  if ('cost_units' in value) {
    const raw = value['cost_units'];
    if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
      throw fail(`${path}.cost_units: must be a non-empty object`);
    }
    const units: Record<string, number> = {};
    for (const [unit, amount] of Object.entries(raw)) {
      if (!UNIT_RE.test(unit)) throw fail(`${path}.cost_units: invalid cost unit name ${q(unit)}`);
      units[unit] = count(amount, `${path}.cost_units.${unit}`);
    }
    spec.costUnits = Object.freeze(units);
  }

  if ('requires_decision' in value) {
    if (typeof value['requires_decision'] !== 'boolean') {
      throw fail(`${path}.requires_decision: must be a boolean`);
    }
    spec.requiresDecision = value['requires_decision'];
  }

  if ('four_eyes_on' in value) {
    const raw = value['four_eyes_on'];
    const message = `${path}.four_eyes_on: must be a non-empty array of unique decision names`;
    if (!Array.isArray(raw) || raw.length === 0) throw fail(message);
    raw.forEach((decision, index) => {
      if (typeof decision !== 'string' || !UNIT_RE.test(decision)) {
        throw fail(`${path}.four_eyes_on[${index}]: invalid decision name ${q(decision)}`);
      }
    });
    if (new Set(raw).size !== raw.length) throw fail(message);
    spec.fourEyesOn = Object.freeze([...(raw as string[])]);
  }

  if (spec.requiresDecision && permission === Permission.READ) {
    throw fail(`${path}: requires_decision is not allowed on a tool with read permission`);
  }
  if (spec.fourEyesOn.length > 0 && !spec.requiresDecision) {
    throw fail(`${path}.four_eyes_on: requires requires_decision: true`);
  }
  return spec;
}

/** Render a ToolSpec in manifest 0.6 object form (omitting unset fields). */
export function toolSpecToObject(spec: ToolSpec): ManifestToolObject {
  const out: ManifestToolObject = { permission: spec.permission };
  if (spec.allowedPurposes !== undefined) out.allowed_purposes = [...spec.allowedPurposes];
  if (spec.caps !== undefined) {
    const caps: ManifestToolCaps = {};
    if (spec.caps.perHour !== undefined) caps.per_hour = spec.caps.perHour;
    if (spec.caps.perDay !== undefined) caps.per_day = spec.caps.perDay;
    if (spec.caps.perCase !== undefined) caps.per_case = spec.caps.perCase;
    out.caps = caps;
  }
  if (spec.costUnits !== undefined) out.cost_units = { ...spec.costUnits };
  if (spec.requiresDecision) out.requires_decision = true;
  if (spec.fourEyesOn.length > 0) out.four_eyes_on = [...spec.fourEyesOn];
  return out;
}

/* ------------------------------------------------------------------ */
/*  ToolManifest                                                       */
/* ------------------------------------------------------------------ */

export interface ToolManifestOptions {
  /** Connector name (e.g., "acme_kyb"). */
  connector: string;
  /** Tool name → permission string or manifest 0.6 tool object. */
  tools: Record<string, ToolDeclaration>;
  /** Manifest version (default "1.0.0"). */
  version?: string;
  /** Human-readable description. */
  description?: string;
}

/**
 * Declares the required permission level for each tool on a connector.
 *
 * Load manifests via `grantex.loadManifest()` and they will be used
 * automatically by `grantex.enforce()`.
 *
 * `tools` maps each tool to its permission (as before 0.6); `getToolSpec()`
 * returns the full declaration including constraints.
 */
export class ToolManifest {
  readonly connector: string;
  readonly tools: Record<string, Permission>;
  readonly version: string;
  readonly description: string;
  readonly #specs: Map<string, ToolSpec> = new Map();

  constructor(options: ToolManifestOptions) {
    if (!options.connector) {
      throw new Error('ToolManifest: connector name is required');
    }
    if (!options.tools || Object.keys(options.tools).length === 0) {
      throw new Error('ToolManifest: at least one tool is required');
    }
    // A manifest that uses the object form anywhere is a 0.6 manifest and is
    // validated in full: names as well as values.
    if (Object.values(options.tools).some((v) => typeof v !== 'string')) {
      checkNames(options.connector, options.tools);
    }

    const tools: Record<string, Permission> = {};
    for (const [name, value] of Object.entries(options.tools)) {
      const spec = parseToolDeclaration(name, value);
      this.#specs.set(name, spec);
      Object.defineProperty(tools, name, { value: spec.permission, enumerable: true, writable: true, configurable: true });
    }

    this.connector = options.connector;
    this.tools = tools;
    this.version = options.version ?? '1.0.0';
    this.description = options.description ?? '';
  }

  /** Get the declared permission for a tool. Returns undefined if not found. */
  getPermission(toolName: string): Permission | undefined {
    return Object.prototype.hasOwnProperty.call(this.tools, toolName) ? this.tools[toolName] : undefined;
  }

  /**
   * Get a tool's full declaration. Returns undefined if the tool is not declared.
   *
   * The permission always reflects `tools`; constraints declared for the tool
   * are kept even if `tools` was edited directly.
   *
   * @throws {ManifestValidationError} `tools` was edited into a combination the
   *   schema forbids (for example `read` on a decision tool).
   */
  getToolSpec(toolName: string): ToolSpec | undefined {
    const permission = this.getPermission(toolName);
    if (permission === undefined) return undefined;
    const spec = this.#specs.get(toolName);
    if (spec === undefined) return { permission, requiresDecision: false, fourEyesOn: [] };
    if (spec.permission !== permission) {
      return parseToolDeclaration(toolName, { ...toolSpecToObject(spec), permission });
    }
    return spec;
  }

  /**
   * Add or update a tool. `permission` is a permission string or a manifest
   * 0.6 tool object; replacing a tool replaces its whole declaration.
   */
  addTool(toolName: string, permission: ToolDeclaration): void {
    const spec = parseToolDeclaration(toolName, permission);
    this.#specs.set(toolName, spec);
    Object.defineProperty(this.tools, toolName, { value: spec.permission, enumerable: true, writable: true, configurable: true });
  }

  /** Number of tools in this manifest. */
  get toolCount(): number {
    return Object.keys(this.tools).length;
  }

  /** Render this manifest as a manifest 0.6 document. */
  toJSON(): { connector: string; version: string; description?: string; tools: Record<string, ToolDeclaration> } {
    const tools: Record<string, ToolDeclaration> = {};
    for (const name of Object.keys(this.tools)) {
      const spec = this.getToolSpec(name) ?? { permission: this.tools[name] as Permission, requiresDecision: false, fourEyesOn: [] };
      const rendered = toolSpecToObject(spec);
      tools[name] = Object.keys(rendered).length === 1 ? spec.permission : rendered;
    }
    return {
      connector: this.connector,
      version: this.version,
      ...(this.description ? { description: this.description } : {}),
      tools,
    };
  }

  /**
   * Load a ToolManifest from a JSON or YAML file.
   * YAML requires the `yaml` package to be installed.
   */
  static async fromFile(filePath: string): Promise<ToolManifest> {
    const fs = await import('node:fs');
    const content = fs.readFileSync(filePath, 'utf-8');
    let data: unknown;
    if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
      try {
        // Dynamic import — yaml is an optional peer dependency
        const yaml = (await import('yaml' as string)) as { parse: (s: string) => unknown };
        data = yaml.parse(content);
      } catch {
        throw new Error('yaml package required for YAML manifests: npm install yaml');
      }
    } else {
      data = JSON.parse(content);
    }
    if (!isPlainObject(data)) throw fail('a manifest must be a JSON object');
    return ToolManifest.fromJSON(data);
  }

  /**
   * Create a ToolManifest from a JSON object (e.g., loaded from file).
   *
   * A manifest that declares `$schema` or uses the object form for any tool
   * is validated against manifest schema 0.6, and an unknown key anywhere is
   * rejected. A manifest made only of permission strings keeps its pre-0.6
   * behaviour: unknown top-level keys are ignored with a deprecation warning
   * (a future minor release will reject them).
   */
  static fromJSON(data: Record<string, unknown>): ToolManifest {
    const connector = data['connector'];
    const tools = data['tools'];
    if (!connector || !tools) {
      throw new Error('ToolManifest.fromJSON: missing "connector" or "tools" field');
    }
    if (!isPlainObject(tools)) {
      throw fail('tools: must be an object mapping tool names to declarations');
    }

    const strict = '$schema' in data || Object.values(tools).some((v) => typeof v !== 'string');
    const unknown = Object.keys(data).filter((k) => !(TOP_LEVEL_KEYS as readonly string[]).includes(k));
    if (strict) {
      if (unknown.length > 0) {
        throw fail(`unknown top-level key ${q(unknown[0])} (allowed: ${TOP_LEVEL_KEYS.join(', ')})`);
      }
      if ('$schema' in data && typeof data['$schema'] !== 'string') {
        throw fail('$schema: must be a string');
      }
      const version = 'version' in data ? data['version'] : '1.0.0';
      const description = 'description' in data ? data['description'] : '';
      checkNames(connector, tools);
      if (typeof version !== 'string' || version.length === 0 || version.length > 64) {
        throw fail('version: must be a non-empty string of at most 64 characters');
      }
      if (typeof description !== 'string') throw fail('description: must be a string');
      return new ToolManifest({
        connector: connector as string,
        tools: tools as Record<string, ToolDeclaration>,
        version,
        description,
      });
    }

    if (unknown.length > 0 && typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      process.emitWarning(
        `ToolManifest: ignoring unknown top-level key ${q(unknown[0])} in manifest for ${q(connector)}; ` +
          'manifest schema 0.6 rejects unknown keys and a future minor release of @grantex/sdk will too',
        'DeprecationWarning',
      );
    }
    return new ToolManifest({
      connector: connector as string,
      tools: tools as Record<string, Permission>,
      version: (data['version'] as string) ?? '1.0.0',
      description: (data['description'] as string) ?? '',
    });
  }
}

/* ------------------------------------------------------------------ */
/*  EnforceResult                                                      */
/* ------------------------------------------------------------------ */

/** Result of a `grantex.enforce()` call. */
export interface EnforceResult {
  /** Whether the tool call is permitted. */
  allowed: boolean;
  /** Human-readable reason if denied. */
  reason: string;
  /** Grant ID from the JWT (empty if token invalid). */
  grantId: string;
  /** Agent DID from the JWT (empty if token invalid). */
  agentDid: string;
  /** All scopes from the grant token. */
  scopes: string[];
  /** Resolved permission for the requested tool. */
  permission: string;
  /** Connector name. */
  connector: string;
  /** Tool name. */
  tool: string;
  /** Denial code from `DenialReason`; absent when allowed. */
  reasonCode?: DenialReason;
  /** Finer-grained denial code, where one applies. */
  subReason?: string;
  /** Structured denial context. Keys are snake_case (`allowed_purposes`, `limit`, `window`), identical to the Python SDK. */
  details?: Record<string, unknown>;
  /** The grant's purpose for this connector, when it carries one. */
  purpose?: string;
  /** Caps reserved for this call, when the tool or grant declares caps. */
  reservation?: Reservation;
  /** Counters this call is metered against (also set when `reserve: false`). */
  capLimits?: readonly CapLimit[];
  /** Tenant of `capLimits`; pass both to `CapsMeter.reserve`. */
  capsTenantId?: string;
  /** In caps warn mode, the cap denial that was not applied. */
  wouldDeny?: WouldDeny;
}

/** A cap denial reported, not applied, in caps warn mode. Keys match the Python SDK. */
export interface WouldDeny {
  reason_code: string;
  sub_reason: string;
  reason: string;
  details: Record<string, unknown>;
}

/** Options for `grantex.enforce()`. */
export interface EnforceOptions {
  /** The Grantex grant token (JWT). */
  grantToken: string;
  /** Connector name (e.g., "salesforce"). */
  connector: string;
  /** Tool name (e.g., "delete_contact"). */
  tool: string;
  /** Amount for capped scope enforcement (optional). */
  amount?: number;
  /** Case the call belongs to; required when a per-case cap applies. Set by the gateway, never the agent. */
  caseId?: string;
  /** Manifest cost units the call incurs (default: all the tool declares). Set by the gateway, never the agent. */
  costComponents?: readonly string[];
  /**
   * `false` checks caps against current usage without consuming anything; reserve
   * later with `CapsMeter.reserve(result.capsTenantId, result.capLimits)` or call
   * `enforce()` again at the call that incurs cost. Default `true`.
   */
  reserve?: boolean;
  /** Overrides the client's caps mode for this call. */
  capsMode?: CapsMode;
  /** Tenant of every counter of this call instead of the grant's developer. */
  capsTenantId?: string;
}

/** Options for `grantex.wrapTool()`. */
export interface WrapToolOptions {
  /** Connector name. */
  connector: string;
  /** Tool name. */
  tool: string;
  /** Grant token — static string or getter function for dynamic tokens. */
  grantToken: string | (() => string);
}

/** Options for `grantex.enforceMiddleware()`. */
export interface EnforceMiddlewareOptions {
  /** Extract the grant token from the request (e.g., from Authorization header). */
  extractToken: (req: Record<string, unknown>) => string | undefined;
  /** Extract the connector name from the request. */
  extractConnector: (req: Record<string, unknown>) => string;
  /** Extract the tool name from the request. */
  extractTool: (req: Record<string, unknown>) => string;
}
