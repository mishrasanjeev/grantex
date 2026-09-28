// SPDX-License-Identifier: Apache-2.0
/**
 * RFC 9651 parsing (section 4.2) and serialization (section 4.1), with the
 * RFC's own examples where it gives them. The Python package runs the same
 * cases (tests/test_structured_fields.py).
 */
import { describe, expect, it } from 'vitest';
import {
  AgentHttpSigError,
  parseDictionary,
  parseItem,
  parseList,
  serializeDictionary,
  serializeItem,
  serializeList,
} from '../src/index.js';

const roundTrips: [string, 'dictionary' | 'list' | 'item', string][] = [
  // RFC 9421 section 2.1.1: strict re-serialization of a Dictionary.
  ['a=1,    b=2;x=1;y=2,   c=(a   b   c)', 'dictionary', 'a=1, b=2;x=1;y=2, c=(a b c)'],
  // RFC 9651 section 3.1.2 ("; cde_456" is a parameter of abc: section 4.2.3.2 skips SP after ";").
  ['abc;a=1;b=2; cde_456, (ghi;jk=4 l);q="9";r=w', 'list', 'abc;a=1;b=2;cde_456, (ghi;jk=4 l);q="9";r=w'],
  ['1; a; b=?0', 'item', '1;a;b=?0'],
  // Boolean true members and parameters are serialized without a value.
  ['a, b;x, c=?0', 'dictionary', 'a, b;x, c=?0'],
  // Duplicate keys: the last value wins, in the first key's position (section 4.2.2).
  ['a=1, b=2, a=3', 'dictionary', 'a=3, b=2'],
  ['"hello \\"world\\" \\\\"', 'item', '"hello \\"world\\" \\\\"'],
  ['foo123/456', 'item', 'foo123/456'],
  ['-999999999999999', 'item', '-999999999999999'],
  ['1.50', 'item', '1.5'],
  ['-0.0', 'item', '0.0'],
  ['4.000', 'item', '4.0'],
  ['?1', 'item', '?1'],
  ['@1659578233', 'item', '@1659578233'],
  ['%"This is intended for display to %c3%bcsers."', 'item', '%"This is intended for display to %c3%bcsers."'],
  [':cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:', 'item', ':cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:'],
  // Missing padding is accepted and restored (section 4.2.7).
  [':cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg:', 'item', ':cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:'],
  ['  sig1=("@method" "@path");created=1618884473;keyid="k"  ', 'dictionary', 'sig1=("@method" "@path");created=1618884473;keyid="k"'],
  ['()', 'list', '()'],
];

const failures: [string, 'dictionary' | 'list' | 'item'][] = [
  ['a=1,', 'dictionary'],
  ['A=1', 'dictionary'],
  ['a=1 b=2', 'dictionary'],
  ['"\\a"', 'item'],
  ['"unterminated', 'item'],
  ['"tab\there"', 'item'],
  ['1234567890123456', 'item'],
  ['1.5000', 'item'],
  ['1234567890123.5', 'item'],
  ['1.', 'item'],
  ['-', 'item'],
  ['?2', 'item'],
  ['@1.5', 'item'],
  [':a*b:', 'item'],
  [':Y=Q=:', 'item'],
  [':YQ==', 'item'],
  ['%"%C3%BC"', 'item'],
  ['%"%c3"', 'item'],
  ['café', 'item'],
  ['(a b', 'list'],
  ['a, ', 'list'],
  ['1 2', 'item'],
  ['', 'item'],
];

function parse(input: string, type: 'dictionary' | 'list' | 'item'): string {
  if (type === 'dictionary') return serializeDictionary(parseDictionary(input));
  if (type === 'list') return serializeList(parseList(input));
  return serializeItem(parseItem(input));
}

describe('structured fields', () => {
  for (const [input, type, expected] of roundTrips) {
    it(`${type} ${JSON.stringify(input)}`, () => {
      expect(parse(input, type)).toBe(expected);
    });
  }

  for (const [input, type] of failures) {
    it(`refuses ${type} ${JSON.stringify(input)}`, () => {
      expect(() => parse(input, type)).toThrow(AgentHttpSigError);
    });
  }

  it('decodes bare items to typed values', () => {
    expect(parseItem('42').value).toEqual({ type: 'integer', value: 42 });
    expect(parseItem('"a\\"b"').value).toEqual({ type: 'string', value: 'a"b' });
    expect(parseItem('*tok:en/1').value).toEqual({ type: 'token', value: '*tok:en/1' });
    expect(parseItem('?0').value).toEqual({ type: 'boolean', value: false });
    expect(parseItem('@-1').value).toEqual({ type: 'date', value: -1 });
    expect(parseItem('%"%c3%bc"').value).toEqual({ type: 'displaystring', value: 'ü' });
    const binary = parseItem(':cHJldGVuZCB0aGlzIGlzIGJpbmFyeSBjb250ZW50Lg==:').value;
    expect(binary.type).toBe('binary');
    expect(Buffer.from(binary.value as Uint8Array).toString('utf8')).toBe('pretend this is binary content.');
  });

  it('serializes an empty list and dictionary as an empty string', () => {
    expect(serializeList(parseList(''))).toBe('');
    expect(serializeDictionary(parseDictionary(''))).toBe('');
  });

  it('refuses to serialize a string with a control character or an out-of-range integer', () => {
    expect(() => serializeItem({ value: { type: 'string', value: 'a\nb' }, params: new Map() })).toThrow(AgentHttpSigError);
    expect(() => serializeItem({ value: { type: 'integer', value: 1e15 }, params: new Map() })).toThrow(AgentHttpSigError);
    expect(() => serializeItem({ value: { type: 'token', value: '1abc' }, params: new Map() })).toThrow(AgentHttpSigError);
  });
});
