/**
 * Derive the counters a tool call is metered against. Mirrors the Python SDK's
 * `grantex.caps._limits`.
 *
 * - The **manifest** (`caps` on the tool) declares tenant-wide counters per tool.
 * - The **grant** (`caps` in its `urn:grantex:tools:v1` entry) declares counters
 *   for that grant only: per tool (`{"verify_business": {"per_hour": 50}}`)
 *   and a connector cost-unit budget (`{"cost_units": {"per_day": 5000}}`).
 *
 * Every declared cap is its own counter and all of them must hold. A call's
 * cost is the sum of the manifest `cost_units` for the components it incurs
 * (all declared components unless the caller names them).
 */

import type { ToolSpec } from '../manifest.js';
import { CapsConfigurationError, MAX_COUNT, type CapLimit, type CapWindow } from './meter.js';

const WINDOWS: readonly CapWindow[] = ['per_hour', 'per_day', 'per_case'];
const MAX_ID = 256;

export const CASE_REQUIRED = 'case_required';
export const INVALID_CASE_ID = 'invalid_case_id';
export const INVALID_COST_COMPONENT = 'invalid_cost_component';
export const MALFORMED_GRANT_CAPS = 'malformed_grant_caps';

/** Unambiguous counter identity; identical to the Python SDK's `counter_id`. */
export function counterId(...parts: string[]): string {
  return JSON.stringify(parts);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function windows(raw: unknown, where: string): Partial<Record<CapWindow, number>> {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new CapsConfigurationError(`${where} must be a non-empty object`, MALFORMED_GRANT_CAPS);
  }
  const out: Partial<Record<CapWindow, number>> = {};
  for (const [window, value] of Object.entries(raw)) {
    if (!(WINDOWS as readonly string[]).includes(window)) {
      throw new CapsConfigurationError(`${where} has unknown window ${JSON.stringify(window)}`, MALFORMED_GRANT_CAPS);
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
      throw new CapsConfigurationError(`${where}.${window} must be an integer between 0 and ${MAX_COUNT}`, MALFORMED_GRANT_CAPS);
    }
    out[window as CapWindow] = value;
  }
  return out;
}

/** Validate a grant entry's `caps`; `cost_units` is the connector budget. */
export function parseGrantCaps(caps: unknown): Map<string, Partial<Record<CapWindow, number>>> {
  const out = new Map<string, Partial<Record<CapWindow, number>>>();
  if (caps === undefined || caps === null) return out;
  if (!isPlainObject(caps)) throw new CapsConfigurationError('grant caps must be an object', MALFORMED_GRANT_CAPS);
  for (const [name, value] of Object.entries(caps)) out.set(name, windows(value, `caps.${name}`));
  return out;
}

export interface BuildCapLimitsOptions {
  connector: string;
  tool: string;
  spec: ToolSpec;
  grantId: string;
  grantCaps?: unknown;
  caseId?: string;
  costComponents?: readonly string[];
}

/**
 * The limits for one call of `tool`.
 *
 * @throws {CapsConfigurationError} with `subReason` `case_required`,
 *   `invalid_case_id`, `invalid_cost_component` or `malformed_grant_caps`.
 */
export function buildCapLimits(options: BuildCapLimitsOptions): CapLimit[] {
  const { connector, tool, spec, grantId, caseId, costComponents } = options;
  if (caseId !== undefined && (typeof caseId !== 'string' || caseId.length === 0 || caseId.length > MAX_ID)) {
    throw new CapsConfigurationError('caseId must be a non-empty string of at most 256 characters', INVALID_CASE_ID);
  }

  const declared: Record<string, number> = { ...(spec.costUnits ?? {}) };
  const components = costComponents === undefined ? Object.keys(declared) : [...costComponents];
  if (
    costComponents !== undefined
    && (new Set(components).size !== components.length || components.some((c) => !Object.prototype.hasOwnProperty.call(declared, c)))
  ) {
    throw new CapsConfigurationError(
      `cost components ${JSON.stringify(components)} are not all declared by tool ${JSON.stringify(tool)}`,
      INVALID_COST_COMPONENT,
    );
  }
  const cost = components.reduce((sum, c) => sum + (declared[c] as number), 0);

  const grant = parseGrantCaps(options.grantCaps);
  const limits: CapLimit[] = [];
  const add = (scopeParts: string[], caps: Partial<Record<CapWindow, number>>, units: number, scope: string, kind: string) => {
    for (const window of WINDOWS) {
      const limit = caps[window];
      if (limit === undefined) continue;
      const parts = [...scopeParts, kind, window];
      if (window === 'per_case') {
        if (caseId === undefined) {
          throw new CapsConfigurationError(`${scope} per_case cap on ${connector}.${tool} needs a caseId`, CASE_REQUIRED);
        }
        parts.push(caseId);
      }
      limits.push({ counter: counterId(...parts), limit, window, units, scope, kind });
    }
  };

  if (spec.caps !== undefined) {
    add(['manifest', connector, tool], { per_hour: spec.caps.perHour, per_day: spec.caps.perDay, per_case: spec.caps.perCase } as Partial<Record<CapWindow, number>>, 1, 'manifest', 'calls');
  }
  const toolCaps = grant.get(tool);
  if (toolCaps !== undefined && tool !== 'cost_units') add(['grant', grantId, connector, tool], toolCaps, 1, 'grant', 'calls');
  const budget = grant.get('cost_units');
  if (cost > 0 && budget !== undefined) add(['grant', grantId, connector], budget, cost, 'grant', 'cost_units');
  return limits;
}
