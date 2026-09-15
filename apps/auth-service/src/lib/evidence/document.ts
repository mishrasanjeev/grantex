/**
 * Strict parsing of evidence package bytes.
 *
 * A package is valid only as its own RFC 8785 canonical form (optionally
 * followed by one line feed). Anything a JSON parser would silently resolve -
 * a duplicate member, a byte-order mark, whitespace, another spelling of a
 * number - is refused, so every byte of a package is significant. The parser
 * accepts exactly the JSON text Python's `json.loads` accepts, so both SDKs
 * reach the same verdict.
 */
import { CanonicalizationError, canonicalize } from './canonical.js';
import { VerificationCode, VerificationFailure } from './result.js';

export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const NUMBER_BYTES = new Set(Array.from('-+.eE0123456789', (c) => c.charCodeAt(0)));
const NUMBER_OPENERS = new Set(Array.from(':,[', (c) => c.charCodeAt(0)));
const SIMPLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A string as RFC 8785 writes it (used for paths and messages). */
export function jsonText(value: string): string {
  try {
    return canonicalize(value);
  } catch {
    return JSON.stringify(value);
  }
}

/** Append a member name or array index to a field path. */
export function formatPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  if (SIMPLE_NAME.test(key)) return base ? `${base}.${key}` : key;
  return `${base}[${jsonText(key)}]`;
}

class ParseError extends Error {}

class DuplicateKey extends Error {
  constructor(readonly member: string) {
    super(member);
  }
}

class BadConstant extends Error {}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skip();
    const value = this.value();
    this.skip();
    if (this.index !== this.text.length) throw new ParseError(`extra data at ${this.index}`);
    return value;
  }

  private skip(): void {
    const t = this.text;
    while (this.index < t.length) {
      const c = t.charCodeAt(this.index);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.index++;
      else break;
    }
  }

  private value(): unknown {
    const t = this.text;
    const c = t[this.index];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (t.startsWith('null', this.index)) {
      this.index += 4;
      return null;
    }
    if (t.startsWith('true', this.index)) {
      this.index += 4;
      return true;
    }
    if (t.startsWith('false', this.index)) {
      this.index += 5;
      return false;
    }
    if (t.startsWith('NaN', this.index) || t.startsWith('Infinity', this.index) || t.startsWith('-Infinity', this.index)) {
      throw new BadConstant(t.startsWith('NaN', this.index) ? 'NaN' : 'Infinity');
    }
    NUMBER.lastIndex = this.index;
    const match = NUMBER.exec(t);
    if (!match) throw new ParseError(`unexpected character at ${this.index}`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  private object(): Record<string, unknown> {
    const t = this.text;
    const out = Object.create(null) as Record<string, unknown>;
    this.index++;
    this.skip();
    if (t[this.index] === '}') {
      this.index++;
      return out;
    }
    for (;;) {
      if (t[this.index] !== '"') throw new ParseError(`expected member name at ${this.index}`);
      const name = this.string();
      this.skip();
      if (t[this.index] !== ':') throw new ParseError(`expected ':' at ${this.index}`);
      this.index++;
      this.skip();
      const value = this.value();
      if (Object.prototype.hasOwnProperty.call(out, name)) throw new DuplicateKey(name);
      out[name] = value;
      this.skip();
      const next = t[this.index];
      this.index++;
      if (next === '}') return out;
      if (next !== ',') throw new ParseError(`expected ',' or '}' at ${this.index - 1}`);
      this.skip();
    }
  }

  private array(): unknown[] {
    const t = this.text;
    const out: unknown[] = [];
    this.index++;
    this.skip();
    if (t[this.index] === ']') {
      this.index++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.skip();
      const next = t[this.index];
      this.index++;
      if (next === ']') return out;
      if (next !== ',') throw new ParseError(`expected ',' or ']' at ${this.index - 1}`);
      this.skip();
    }
  }

  private string(): string {
    const t = this.text;
    let out = '';
    let start = ++this.index;
    for (;;) {
      if (this.index >= t.length) throw new ParseError('unterminated string');
      const code = t.charCodeAt(this.index);
      if (code === 0x22) {
        out += t.slice(start, this.index);
        this.index++;
        return out;
      }
      if (code < 0x20) throw new ParseError(`control character in string at ${this.index}`);
      if (code !== 0x5c) {
        this.index++;
        continue;
      }
      out += t.slice(start, this.index);
      const escape = t[this.index + 1];
      this.index += 2;
      switch (escape) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += String.fromCharCode(0x08); break;
        case 'f': out += String.fromCharCode(0x0c); break;
        case 'n': out += String.fromCharCode(0x0a); break;
        case 'r': out += String.fromCharCode(0x0d); break;
        case 't': out += String.fromCharCode(0x09); break;
        case 'u': {
          const hex = t.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError(`invalid escape at ${this.index}`);
          out += String.fromCharCode(parseInt(hex, 16));
          this.index += 4;
          break;
        }
        default:
          throw new ParseError(`invalid escape at ${this.index - 1}`);
      }
      start = this.index;
    }
  }
}

function hasBadNumber(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return true;
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (item !== null && typeof item === 'object') {
      stack.push(...Object.values(item));
    }
  }
  return false;
}

function inNumber(buffer: Uint8Array, index: number): boolean {
  let start = index;
  while (start > 0 && NUMBER_BYTES.has(buffer[start - 1]!)) start--;
  if (start === 0 || !NUMBER_OPENERS.has(buffer[start - 1]!)) return false;
  return start < index || (index < buffer.length && NUMBER_BYTES.has(buffer[index]!));
}

/** Parse package bytes, refusing anything that is not canonical JSON. */
export function parseCanonical(data: Uint8Array, maxBytes: number = DEFAULT_MAX_BYTES): unknown {
  if (data.length > maxBytes) {
    throw new VerificationFailure(
      VerificationCode.TOO_LARGE,
      `package is ${data.length} bytes; the limit is ${maxBytes}`,
    );
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    throw new VerificationFailure(VerificationCode.MALFORMED_JSON, 'package starts with a byte-order mark');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new VerificationFailure(VerificationCode.MALFORMED_JSON, 'package is not UTF-8');
  }
  let value: unknown;
  try {
    value = new Parser(text).parse();
  } catch (err) {
    if (err instanceof DuplicateKey) {
      throw new VerificationFailure(
        VerificationCode.DUPLICATE_KEY,
        `member ${jsonText(err.member)} appears more than once in one object`,
      );
    }
    if (err instanceof BadConstant) {
      throw new VerificationFailure(VerificationCode.NON_CANONICAL_NUMBER, `${err.message} is not a JSON number`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new VerificationFailure(VerificationCode.MALFORMED_JSON, `package is not valid JSON: ${message}`);
  }
  if (hasBadNumber(value)) {
    throw new VerificationFailure(VerificationCode.NON_CANONICAL_NUMBER, 'a number has no exact IEEE-754 double form');
  }
  let canonical: Uint8Array;
  try {
    canonical = new TextEncoder().encode(canonicalize(value));
  } catch (err) {
    if (err instanceof CanonicalizationError || err instanceof RangeError) {
      throw new VerificationFailure(
        VerificationCode.NON_CANONICAL_DOCUMENT,
        `package has no canonical form: ${err.message}`,
      );
    }
    throw err;
  }
  const body = data.length > 0 && data[data.length - 1] === 0x0a ? data.subarray(0, data.length - 1) : data;
  let same = body.length === canonical.length;
  let index = 0;
  const limit = Math.min(body.length, canonical.length);
  while (index < limit && body[index] === canonical[index]) index++;
  same = same && index === limit;
  if (!same) {
    if (inNumber(body, index)) {
      throw new VerificationFailure(
        VerificationCode.NON_CANONICAL_NUMBER,
        `number at byte ${index} is not in RFC 8785 form`,
      );
    }
    throw new VerificationFailure(
      VerificationCode.NON_CANONICAL_DOCUMENT,
      `package bytes differ from their RFC 8785 form at byte ${index}`,
    );
  }
  return value;
}
