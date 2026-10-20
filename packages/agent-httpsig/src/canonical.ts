// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON values this library
 * signs: object members sorted by their UTF-16 code units (section 3.2.3),
 * no whitespace, and ECMAScript number and string serialization (section
 * 3.2.2), which `JSON.stringify` implements. Members whose value is
 * `undefined` are left out.
 */
import { AgentHttpSigError } from './errors.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AgentHttpSigError('JSON has no representation for a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new AgentHttpSigError(`JSON has no representation for a ${typeof value}`);
}
