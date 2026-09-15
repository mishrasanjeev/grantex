/**
 * JSON Canonicalization Scheme (RFC 8785) for evidence packages.
 *
 * A verbatim copy of `canonical.ts` from the decision-grant canonicalisation
 * work (spec/canonicalization.md), private to the evidence module until that
 * file is released. The two must stay identical: once `src/canonical.ts` is on
 * main this copy is replaced by a re-export of it.
 *
 * `canonicalize` turns a JSON value into its canonical text: object members
 * sorted by the UTF-16 code units of their names, no insignificant
 * whitespace, strings escaped as `JSON.stringify` escapes them and numbers in
 * the ECMAScript `Number` format. Two values that differ only in member order,
 * whitespace or number spelling canonicalise to the same text.
 *
 * The input must be I-JSON (RFC 7493). Anything without a single canonical
 * form throws `CanonicalizationError` instead of being coerced or dropped:
 * `NaN` and infinities; strings or member names with an unpaired surrogate;
 * `undefined`, functions, symbols, bigints, sparse arrays and objects that
 * are not plain objects (such as `Date` or `Map`, whose `toJSON` is not
 * consulted); nesting deeper than `MAX_DEPTH`.
 *
 * The Python SDK implements the same rules in `grantex.canonical`; both are
 * tested against the RFC 8785 test vectors and the shared fixtures in
 * `spec/examples/canonicalization/`. Python additionally refuses integers
 * whose digits are not the canonical form of a double (such as 2^53 + 1);
 * a JavaScript number has already been rounded by the parser.
 */

/** Deepest nesting of arrays and objects accepted. */
export const MAX_DEPTH = 64;

/** The value has no RFC 8785 canonical form. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Returns the RFC 8785 canonical JSON text of `value`. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join('');
}

/** Returns the RFC 8785 canonical JSON of `value` as UTF-8 bytes. */
export function canonicalizeToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/** Serialises a finite number as `Number.prototype.toString` does (`-0` as `0`). */
export function serializeNumber(value: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CanonicalizationError('NaN and infinite numbers have no JSON form');
  }
  // JSON.stringify applies Number::toString and writes -0 as 0.
  return JSON.stringify(value);
}

function write(value: unknown, out: string[], depth: number): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(serializeNumber(value));
      return;
    case 'string':
      out.push(serializeString(value));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`value of type ${typeof value} has no JSON form`);
  }
  if (depth >= MAX_DEPTH) {
    throw new CanonicalizationError(`nesting deeper than ${MAX_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new CanonicalizationError('sparse arrays have no JSON form');
      }
      if (index > 0) out.push(',');
      write(value[index], out, depth + 1);
    }
    out.push(']');
    return;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalizationError('only plain objects have a JSON form');
  }
  const record = value as Record<string, unknown>;
  // Array.prototype.sort without a comparator orders strings by UTF-16 code units.
  const keys = Object.keys(record).sort();
  out.push('{');
  keys.forEach((key, index) => {
    if (index > 0) out.push(',');
    out.push(serializeString(key));
    out.push(':');
    write(record[key], out, depth + 1);
  });
  out.push('}');
}

function serializeString(value: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalizationError('string contains an unpaired surrogate');
  }
  // For well-formed strings JSON.stringify escapes exactly as RFC 8785 requires:
  // \b \t \n \f \r \" \\ as two-character escapes, other C0 controls as \u00xx.
  return JSON.stringify(value);
}
