// SPDX-License-Identifier: Apache-2.0
/**
 * Structured Field Values for HTTP, RFC 9651: parsing (section 4.2) and
 * serialization (section 4.1). RFC 9421 relies on both (sections 2.1.1, 2.3,
 * 4.1, 4.2), and its section 7.5.3 warns that a lax parser opens attacks on
 * the signature base, so this follows the RFC's algorithms step by step and
 * fails on anything they fail on.
 */
import { AgentHttpSigError } from './errors.js';

export type BareItem =
  | { type: 'integer'; value: number }
  /** Kept as the parsed digits, so a decimal serializes exactly. */
  | { type: 'decimal'; value: string }
  | { type: 'string'; value: string }
  | { type: 'token'; value: string }
  | { type: 'binary'; value: Uint8Array }
  | { type: 'boolean'; value: boolean }
  | { type: 'date'; value: number }
  | { type: 'displaystring'; value: string };

export type Parameters = Map<string, BareItem>;
export interface Item {
  value: BareItem;
  params: Parameters;
}
export interface InnerList {
  items: Item[];
  params: Parameters;
}
export type Member = Item | InnerList;
export type Dictionary = Map<string, Member>;
export type List = Member[];

const MAX_INTEGER = 999_999_999_999_999;

function fail(message: string): never {
  throw new AgentHttpSigError(`structured field: ${message}`);
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isLcAlpha = (c: string | undefined) => c !== undefined && c >= 'a' && c <= 'z';
const isAlpha = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
// tchar, RFC 9110 section 5.6.2.
const TCHAR = "!#$%&'*+-.^_`|~";
const isTchar = (c: string | undefined) => c !== undefined && (isAlpha(c) || isDigit(c) || TCHAR.includes(c));
const isKeyChar = (c: string | undefined) => c !== undefined && (isLcAlpha(c) || isDigit(c) || '_-.*'.includes(c));
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Standard base64 as RFC 9651 section 4.2.7 accepts it: characters outside
 * the alphabet fail, missing padding is synthesized, and "=" may only end
 * the value.
 */
export function decodeBase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) fail('invalid base64');
  const unpadded = text.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) fail('invalid base64 length');
  return new Uint8Array(Buffer.from(unpadded, 'base64'));
}

/** Padded standard base64 (RFC 9651 section 4.1.8). */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

class Parser {
  pos = 0;
  constructor(readonly input: string) {
    // Section 4.2 step 1: the field value must be ASCII.
    for (let i = 0; i < input.length; i++) {
      if (input.charCodeAt(i) > 0x7f) fail('non-ASCII input');
    }
  }
  get done() {
    return this.pos >= this.input.length;
  }
  peek(): string | undefined {
    return this.input[this.pos];
  }
  skipSP() {
    while (this.peek() === ' ') this.pos++;
  }
  skipOWS() {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  // Section 4.2.1
  parseList(): List {
    const members: List = [];
    while (!this.done) {
      members.push(this.parseItemOrInnerList());
      this.skipOWS();
      if (this.done) return members;
      if (this.input[this.pos++] !== ',') fail('expected "," in list');
      this.skipOWS();
      if (this.done) fail('trailing comma in list');
    }
    return members;
  }

  // Section 4.2.1.1
  parseItemOrInnerList(): Member {
    return this.peek() === '(' ? this.parseInnerList() : this.parseItem();
  }

  // Section 4.2.1.2
  parseInnerList(): InnerList {
    if (this.input[this.pos++] !== '(') fail('expected "("');
    const items: Item[] = [];
    while (!this.done) {
      this.skipSP();
      if (this.peek() === ')') {
        this.pos++;
        return { items, params: this.parseParameters() };
      }
      items.push(this.parseItem());
      const c = this.peek();
      if (c !== ' ' && c !== ')') fail('expected SP or ")" in inner list');
    }
    return fail('unterminated inner list');
  }

  // Section 4.2.2
  parseDictionary(): Dictionary {
    const dictionary: Dictionary = new Map();
    while (!this.done) {
      const key = this.parseKey();
      let member: Member;
      if (this.peek() === '=') {
        this.pos++;
        member = this.parseItemOrInnerList();
      } else {
        member = { value: { type: 'boolean', value: true }, params: this.parseParameters() };
      }
      // Step 2.4: a repeated key overwrites the value and keeps its position.
      dictionary.set(key, member);
      this.skipOWS();
      if (this.done) return dictionary;
      if (this.input[this.pos++] !== ',') fail('expected "," in dictionary');
      this.skipOWS();
      if (this.done) fail('trailing comma in dictionary');
    }
    return dictionary;
  }

  // Section 4.2.3
  parseItem(): Item {
    const value = this.parseBareItem();
    return { value, params: this.parseParameters() };
  }

  // Section 4.2.3.1
  parseBareItem(): BareItem {
    const c = this.peek();
    if (c === '-' || isDigit(c)) return this.parseNumber();
    if (c === '"') return { type: 'string', value: this.parseString() };
    if (isAlpha(c) || c === '*') return { type: 'token', value: this.parseToken() };
    if (c === ':') return { type: 'binary', value: this.parseByteSequence() };
    if (c === '?') return { type: 'boolean', value: this.parseBoolean() };
    if (c === '@') return this.parseDate();
    if (c === '%') return { type: 'displaystring', value: this.parseDisplayString() };
    return fail('unrecognized item');
  }

  // Section 4.2.3.2
  parseParameters(): Parameters {
    const params: Parameters = new Map();
    while (this.peek() === ';') {
      this.pos++;
      this.skipSP();
      const key = this.parseKey();
      let value: BareItem = { type: 'boolean', value: true };
      if (this.peek() === '=') {
        this.pos++;
        value = this.parseBareItem();
      }
      params.set(key, value);
    }
    return params;
  }

  // Section 4.2.3.3
  parseKey(): string {
    const first = this.peek();
    if (!isLcAlpha(first) && first !== '*') fail('invalid key');
    const start = this.pos;
    while (isKeyChar(this.peek())) this.pos++;
    return this.input.slice(start, this.pos);
  }

  // Section 4.2.4
  parseNumber(): BareItem {
    let type: 'integer' | 'decimal' = 'integer';
    let sign = '';
    let digits = '';
    if (this.peek() === '-') {
      this.pos++;
      sign = '-';
    }
    if (this.done) fail('empty integer');
    if (!isDigit(this.peek())) fail('expected a digit');
    while (!this.done) {
      const c = this.input[this.pos]!;
      if (isDigit(c)) {
        digits += c;
        this.pos++;
      } else if (type === 'integer' && c === '.') {
        if (digits.length > 12) fail('decimal integer part too long');
        digits += c;
        type = 'decimal';
        this.pos++;
      } else {
        break;
      }
      if (type === 'integer' && digits.length > 15) fail('integer too long');
      if (type === 'decimal' && digits.length > 16) fail('decimal too long');
    }
    if (type === 'integer') return { type, value: Number(sign + digits) };
    if (digits.endsWith('.')) fail('decimal ends with "."');
    if (digits.length - digits.indexOf('.') - 1 > 3) fail('decimal has more than three fractional digits');
    return { type, value: sign + digits };
  }

  // Section 4.2.5
  parseString(): string {
    if (this.input[this.pos++] !== '"') fail('expected DQUOTE');
    let out = '';
    while (!this.done) {
      const c = this.input[this.pos++]!;
      if (c === '\\') {
        if (this.done) fail('unterminated escape');
        const next = this.input[this.pos++]!;
        if (next !== '"' && next !== '\\') fail('invalid escape');
        out += next;
      } else if (c === '"') {
        return out;
      } else {
        const code = c.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) fail('invalid character in string');
        out += c;
      }
    }
    return fail('unterminated string');
  }

  // Section 4.2.6
  parseToken(): string {
    const first = this.peek();
    if (!isAlpha(first) && first !== '*') fail('invalid token');
    const start = this.pos;
    while (!this.done) {
      const c = this.peek();
      if (!isTchar(c) && c !== ':' && c !== '/') break;
      this.pos++;
    }
    return this.input.slice(start, this.pos);
  }

  // Section 4.2.7
  parseByteSequence(): Uint8Array {
    if (this.input[this.pos++] !== ':') fail('expected ":"');
    const end = this.input.indexOf(':', this.pos);
    if (end === -1) fail('unterminated byte sequence');
    const content = this.input.slice(this.pos, end);
    this.pos = end + 1;
    return decodeBase64(content);
  }

  // Section 4.2.8
  parseBoolean(): boolean {
    if (this.input[this.pos++] !== '?') fail('expected "?"');
    const c = this.input[this.pos];
    if (c === '1' || c === '0') {
      this.pos++;
      return c === '1';
    }
    return fail('invalid boolean');
  }

  // Section 4.2.9
  parseDate(): BareItem {
    if (this.input[this.pos++] !== '@') fail('expected "@"');
    const n = this.parseNumber();
    if (n.type !== 'integer') fail('date is not an integer');
    return { type: 'date', value: n.value };
  }

  // Section 4.2.10
  parseDisplayString(): string {
    if (this.input[this.pos] !== '%' || this.input[this.pos + 1] !== '"') fail('expected %"');
    this.pos += 2;
    const bytes: number[] = [];
    while (!this.done) {
      const c = this.input[this.pos++]!;
      const code = c.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) fail('invalid character in display string');
      if (c === '%') {
        const hex = this.input.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-f]{2}$/.test(hex)) fail('invalid percent-encoding in display string');
        bytes.push(parseInt(hex, 16));
        this.pos += 2;
      } else if (c === '"') {
        try {
          return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
        } catch {
          // Invalid UTF-8 fails parsing (step 4.4.1); that failure is the outcome.
          return fail('display string is not UTF-8');
        }
      } else {
        bytes.push(code);
      }
    }
    return fail('unterminated display string');
  }
}

// Section 4.2 steps 2, 6 and 7: surrounding spaces are discarded and
// nothing may follow the value.
function parseField<T>(input: string, parse: (p: Parser) => T): T {
  const p = new Parser(input);
  p.skipSP();
  const out = parse(p);
  p.skipSP();
  if (!p.done) fail('unexpected characters after the value');
  return out;
}

export const parseList = (input: string): List => parseField(input, (p) => p.parseList());
export const parseDictionary = (input: string): Dictionary => parseField(input, (p) => p.parseDictionary());
export const parseItem = (input: string): Item => parseField(input, (p) => p.parseItem());

// Section 4.1.1
export function serializeList(list: List): string {
  return list.map(serializeMember).join(', ');
}

function serializeMember(member: Member): string {
  return 'items' in member ? serializeInnerList(member) : serializeItem(member);
}

// Section 4.1.1.1
export function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(' ')})${serializeParameters(list.params)}`;
}

// Section 4.1.1.2
export function serializeParameters(params: Parameters): string {
  let out = '';
  for (const [key, value] of params) {
    out += `;${serializeKey(key)}`;
    if (!(value.type === 'boolean' && value.value)) out += `=${serializeBareItem(value)}`;
  }
  return out;
}

// Section 4.1.1.3
export function serializeKey(key: string): string {
  if (!/^[a-z*][a-z0-9_\-.*]*$/.test(key)) fail(`invalid key ${JSON.stringify(key)}`);
  return key;
}

// Section 4.1.2
export function serializeDictionary(dictionary: Dictionary): string {
  const out: string[] = [];
  for (const [key, member] of dictionary) {
    if (!('items' in member) && member.value.type === 'boolean' && member.value.value) {
      out.push(serializeKey(key) + serializeParameters(member.params));
    } else {
      out.push(`${serializeKey(key)}=${serializeMember(member)}`);
    }
  }
  return out.join(', ');
}

// Section 4.1.3
export function serializeItem(item: Item): string {
  return serializeBareItem(item.value) + serializeParameters(item.params);
}

// Section 4.1.3.1
export function serializeBareItem(item: BareItem): string {
  switch (item.type) {
    case 'integer':
      return serializeInteger(item.value);
    case 'decimal':
      return serializeDecimal(item.value);
    case 'string':
      return serializeString(item.value);
    case 'token':
      // Section 4.1.7
      if (!/^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*$/.test(item.value)) fail('invalid token');
      return item.value;
    case 'binary':
      // Section 4.1.8
      return `:${encodeBase64(item.value)}:`;
    case 'boolean':
      // Section 4.1.9
      return item.value ? '?1' : '?0';
    case 'date':
      // Section 4.1.10
      return `@${serializeInteger(item.value)}`;
    case 'displaystring':
      return serializeDisplayString(item.value);
  }
}

// Section 4.1.4
function serializeInteger(value: number): string {
  if (!Number.isInteger(value) || value < -MAX_INTEGER || value > MAX_INTEGER) fail('integer out of range');
  return Object.is(value, -0) ? '0' : String(value);
}

// Section 4.1.5, for a decimal held as its parsed digits: at most three
// fractional digits, so no rounding is needed.
function serializeDecimal(value: string): string {
  const m = /^(-?)(\d{1,12})\.(\d{1,3})$/.exec(value);
  if (!m) return fail('invalid decimal');
  // Zeros are stripped by scanning rather than by a regular expression, so
  // the time taken is linear in the number of digits.
  const digits = m[2]!;
  const fractionDigits = m[3]!;
  let first = 0;
  while (first < digits.length - 1 && digits[first] === '0') first++;
  const integer = digits.slice(first);
  let last = fractionDigits.length;
  while (last > 0 && fractionDigits[last - 1] === '0') last--;
  const fraction = fractionDigits.slice(0, last) || '0';
  const zero = integer === '0' && last === 0;
  return `${m[1] === '-' && !zero ? '-' : ''}${integer}.${fraction}`;
}

// Section 4.1.6
function serializeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) fail('string has a character outside VCHAR and SP');
    if (c === '\\' || c === '"') out += '\\';
    out += c;
  }
  return `${out}"`;
}

// Section 4.1.11
function serializeDisplayString(value: string): string {
  // UTF-8 cannot encode a lone surrogate (step 2).
  if (LONE_SURROGATE.test(value)) fail('display string is not well-formed Unicode');
  let out = '%"';
  for (const byte of new TextEncoder().encode(value)) {
    if (byte === 0x25 || byte === 0x22 || byte < 0x20 || byte > 0x7e) {
      out += `%${byte.toString(16).padStart(2, '0')}`;
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return `${out}"`;
}
