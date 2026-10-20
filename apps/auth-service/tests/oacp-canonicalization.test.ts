// SPDX-License-Identifier: Apache-2.0
/**
 * OACP payloads are canonicalised with RFC 8785 (JCS). The shared vector file
 * (spec/examples/oacp/oacp-artifact-jws-v1.json) pins the canonical text and
 * hash of a payload whose member names order differently under
 * `localeCompare` (the order OACP used before) and under UTF-16 code units
 * (RFC 8785 §3.2.3, and Python's `sort_keys=True`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalizeOacpPayload, hashOacpPayload, stripUndefinedMembers } from '../src/lib/commerce/oacp-trust-artifacts.js';
import { stableJson } from '../src/lib/commerce/idempotency.js';

const VECTORS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../spec/examples/oacp/oacp-artifact-jws-v1.json'),
  'utf8',
)) as {
  payload_canonical: string;
  payload_hash: string;
  cases: Array<{ name: string; payload: Record<string, unknown> }>;
};

const payload = VECTORS.cases.find((entry) => entry.name === 'valid')!.payload;

describe('OACP canonical JSON (RFC 8785)', () => {
  it('keeps a member named __proto__ as a member and leaves the prototype alone', () => {
    const payload = JSON.parse('{"b":1,"__proto__":{"polluted":true,"gone":null},"a":2}') as unknown;
    const stripped = stripUndefinedMembers(payload) as Record<string, unknown>;
    expect(Object.getPrototypeOf(stripped)).toBe(Object.prototype);
    expect((stripped as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.keys(stripped)).toEqual(['b', '__proto__', 'a']);
    expect(canonicalizeOacpPayload(payload)).toBe('{"__proto__":{"gone":null,"polluted":true},"a":2,"b":1}');
  });

  it('reproduces the shared vector canonical text and payload hash', () => {
    expect(canonicalizeOacpPayload(payload)).toBe(VECTORS.payload_canonical);
    expect(hashOacpPayload(payload)).toBe(VECTORS.payload_hash);
  });

  it('no longer uses the localeCompare order, which disagrees with RFC 8785', () => {
    // The regression: the previous canonicalizer produced different bytes,
    // so a Python or Go verifier computed a different payload_hash.
    expect(stableJson(payload)).not.toBe(VECTORS.payload_canonical);
    expect(canonicalizeOacpPayload({ ab: 2, a_b: 1, Zeta: 0 })).toBe('{"Zeta":0,"a_b":1,"ab":2}');
  });

  it('drops absent (undefined) members recursively before canonicalising', () => {
    expect(canonicalizeOacpPayload({ b: undefined, a: { d: undefined, c: [1, { e: undefined }] } }))
      .toBe('{"a":{"c":[1,{}]}}');
    expect(stripUndefinedMembers([{ a: undefined }])).toEqual([{}]);
  });

  it('refuses values that have no JSON form instead of coercing them', () => {
    expect(() => canonicalizeOacpPayload({ when: new Date(0) })).toThrow();
    expect(() => canonicalizeOacpPayload({ n: Number.NaN })).toThrow();
  });
});
