/**
 * RFC 8785 canonicalisation: the RFC test vectors, the ES6 number test and the
 * cases shared with the Python SDK (spec/examples/canonicalization/).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanonicalizationError,
  MAX_DEPTH,
  canonicalize,
  canonicalizeToBytes,
  serializeNumber,
} from '../src/canonical.js';

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'canonicalization');
const VECTORS = join(EXAMPLES, 'rfc8785');
const VECTOR_NAMES = readdirSync(join(VECTORS, 'input')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

describe('RFC 8785 test vectors', () => {
  it('has the full vector set', () => {
    expect(VECTOR_NAMES).toEqual(['arrays', 'french', 'structures', 'unicode', 'values', 'weird']);
  });

  it.each(VECTOR_NAMES)('%s', (name) => {
    const value: unknown = JSON.parse(readFileSync(join(VECTORS, 'input', `${name}.json`), 'utf-8'));
    const expected = readFileSync(join(VECTORS, 'output', `${name}.json`));
    const expectedHex = Buffer.from(readFileSync(join(VECTORS, 'outhex', `${name}.txt`), 'ascii').replace(/\s+/g, ''), 'hex');
    expect(expected.equals(expectedHex)).toBe(true);
    expect(Buffer.from(canonicalizeToBytes(value)).equals(expected)).toBe(true);
  });
});

describe('ES6 number serialisation', () => {
  interface NumberFixture {
    static_u64: string[];
    serial_count: number;
    checksums: { lines: number; bytes: number; sha256: string }[];
  }
  const fixture = JSON.parse(readFileSync(join(EXAMPLES, 'es6-numbers.json'), 'utf-8')) as NumberFixture;

  function* patterns(): Generator<bigint> {
    for (const text of fixture.static_u64) yield BigInt(`0x${text}`);
    for (let i = 0; i < fixture.serial_count; i++) yield 0x0010000000000000n + BigInt(i);
    let block = Buffer.alloc(32);
    for (;;) {
      block = createHash('sha256').update(block).digest();
      for (let offset = 0; offset < 32; offset += 8) {
        const value = block.readDoubleLE(offset);
        if (value === 0 || !Number.isFinite(value)) continue;
        yield block.readBigUInt64LE(offset);
      }
    }
  }

  it('matches the RFC 8785 checksums', () => {
    const targets = new Map(fixture.checksums.map((c) => [c.lines, c]));
    const last = Math.max(...targets.keys());
    expect(last).toBeGreaterThanOrEqual(100000);
    const hash = createHash('sha256');
    const scratch = Buffer.alloc(8);
    let count = 0;
    let size = 0;
    let checked = 0;
    for (const pattern of patterns()) {
      scratch.writeBigUInt64LE(pattern);
      const line = `${pattern.toString(16)},${serializeNumber(scratch.readDoubleLE(0))}\n`;
      hash.update(line, 'ascii');
      size += line.length;
      count++;
      const target = targets.get(count);
      if (target) {
        expect(size).toBe(target.bytes);
        expect(hash.copy().digest('hex')).toBe(target.sha256);
        checked++;
        if (count === last) break;
      }
    }
    expect(checked).toBe(targets.size);
  });
});

interface ParityFixture {
  valid: { name: string; input: string; canonical: string }[];
  invalid: { name: string; input: string }[];
}
const PARITY = JSON.parse(readFileSync(join(EXAMPLES, 'parity.json'), 'utf-8')) as ParityFixture;

describe('shared canonicalisation cases', () => {
  it.each(PARITY.valid.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(canonicalize(JSON.parse(c.input))).toBe(c.canonical);
  });
  it.each(PARITY.invalid.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    expect(() => canonicalize(JSON.parse(c.input))).toThrow(CanonicalizationError);
  });
});

describe('canonicalize', () => {
  it('writes -0 and integer-valued numbers without a fraction', () => {
    expect(canonicalize([-0, 0, 1.0, 1e3, -5.0, 2 ** 60])).toBe('[0,0,1,1000,-5,1152921504606847000]');
  });

  it.each([NaN, Infinity, -Infinity])('refuses %s', (value) => {
    expect(() => canonicalize({ n: value })).toThrow(CanonicalizationError);
  });

  it.each([
    ['undefined', undefined],
    ['undefined member', { a: undefined }],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['bigint', 1n],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['class instance', new (class Example { a = 1; })()],
  ])('refuses %s', (_name, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it('refuses sparse arrays', () => {
    const sparse: unknown[] = [];
    sparse[2] = 1;
    expect(() => canonicalize(sparse)).toThrow(CanonicalizationError);
  });

  it('accepts objects without a prototype', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value['b'] = 1;
    value['a'] = 2;
    expect(canonicalize(value)).toBe('{"a":2,"b":1}');
  });

  it('enforces the nesting limit', () => {
    let ok: unknown = 1;
    for (let i = 0; i < MAX_DEPTH; i++) ok = [ok];
    expect(() => canonicalize(ok)).not.toThrow();
    expect(() => canonicalize([ok])).toThrow(CanonicalizationError);
  });

  it('is stable under reordering and re-serialisation (property)', () => {
    let seed = 8785;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
    const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
    const text = (n: number, ranges: readonly [number, number][]): string => {
      let out = '';
      for (let i = 0; i < n; i++) {
        const [lo, hi] = pick(ranges);
        out += String.fromCodePoint(int(lo, hi));
      }
      return out;
    };
    const randomValue = (depth: number): unknown => {
      const kind = int(0, depth < 4 ? 7 : 4);
      if (kind === 0) return null;
      if (kind === 1) return random() < 0.5;
      if (kind === 2) return pick([int(-1e9, 1e9), (random() - 0.5) * 2e6, random() * 10 ** int(-30, 30)]);
      if (kind === 3 || kind === 4) return text(int(0, 6), [[0x20, 0x7e], [0, 0x1f], [0xa0, 0xd7ff], [0x10000, 0x10ffff]]);
      if (kind === 5 || kind === 6) {
        const out: Record<string, unknown> = {};
        for (let i = int(0, 5); i > 0; i--) out[text(int(0, 4), [[0x41, 0x7a], [0xe0, 0xff], [0x1f600, 0x1f64f], [0xfb00, 0xfb4f]])] = randomValue(depth + 1);
        return out;
      }
      return Array.from({ length: int(0, 5) }, () => randomValue(depth + 1));
    };
    const shuffled = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(shuffled);
      if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        for (let i = entries.length - 1; i > 0; i--) {
          const j = int(0, i);
          [entries[i], entries[j]] = [entries[j]!, entries[i]!];
        }
        return Object.fromEntries(entries.map(([k, v]) => [k, shuffled(v)]));
      }
      return value;
    };
    for (let i = 0; i < 500; i++) {
      const value = randomValue(0);
      const canonical = canonicalize(value);
      expect(canonicalize(JSON.parse(canonical))).toBe(canonical);
      expect(canonicalize(JSON.parse(JSON.stringify(shuffled(value), null, pick([0, 1, 4]))))).toBe(canonical);
    }
  });
});
