// SPDX-License-Identifier: Apache-2.0
//
// The two status-list codecs against the examples in their specifications:
// draft-ietf-oauth-status-list-21 sections 4.1 (the byte arrays) and 4.2 (the
// same lists as lst), and the W3C Bitstring Status List v1.0 Recommendation of
// 15 May 2025 (the encodedList of Examples 3, 5 and 7).

import { gunzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BITSTRING_MIN_ENTRIES,
  StatusListCodecError,
  decodeBitstringStatusList,
  decodeTokenStatusList,
  encodeBitstringStatusList,
  encodeTokenStatusList,
} from '../src/index.ts';

// draft-ietf-oauth-status-list-21 section 4.1, first example: 16 entries, 1 bit, bytes b9 a3;
// the lst is the section 4.2 JSON example.
const TSL_1BIT = { lst: 'eNrbuRgAAhcBXQ', bytes: [0xb9, 0xa3], statuses: [1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1] };
// Section 4.1, second example: 12 entries, 2 bits, bytes c9 44 f9; lst from section 4.2.
const TSL_2BIT = { lst: 'eNo76fITAAPfAgc', bytes: [0xc9, 0x44, 0xf9], statuses: [1, 2, 0, 3, 0, 1, 0, 1, 1, 2, 3, 3] };
// Bitstring Status List v1.0 Examples 3 (section 2.2), 5 (A.2) and 7 (A.4): an encodedList with no bit set.
const BSL_EMPTY = 'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA';

describe('Token Status List codec (draft-ietf-oauth-status-list-21 section 4)', () => {
  it('decodes the section 4.1 one-bit example', () => {
    const list = decodeTokenStatusList({ bits: 1, lst: TSL_1BIT.lst });
    expect(list.size).toBe(16);
    expect(TSL_1BIT.statuses.map((_, idx) => list.statusAt(idx))).toEqual(TSL_1BIT.statuses);
  });

  it('decodes the section 4.1 two-bit example', () => {
    const list = decodeTokenStatusList({ bits: 2, lst: TSL_2BIT.lst });
    expect(list.size).toBe(12);
    expect(TSL_2BIT.statuses.map((_, idx) => list.statusAt(idx))).toEqual(TSL_2BIT.statuses);
  });

  it('encodes the examples to the same byte arrays (DEFLATE output may differ, the bytes may not)', () => {
    for (const [bits, vector] of [[1, TSL_1BIT], [2, TSL_2BIT]] as const) {
      const lst = encodeTokenStatusList(
        vector.statuses.map((status, idx) => ({ idx, status })),
        { bits, size: vector.statuses.length },
      );
      expect([...inflateSync(Buffer.from(lst, 'base64url'))]).toEqual(vector.bytes);
    }
  });

  it('packs from the least significant bit (section 4.1 step 3)', () => {
    const lst = encodeTokenStatusList([{ idx: 0, status: 2 }], { bits: 2, size: 8 });
    expect([...inflateSync(Buffer.from(lst, 'base64url'))]).toEqual([0x02, 0x00]);
  });

  it('refuses a width, index or value the draft does not allow', () => {
    expect(() => encodeTokenStatusList([], { bits: 3 as 1, size: 8 })).toThrow(StatusListCodecError);
    expect(() => encodeTokenStatusList([{ idx: 8, status: 1 }], { bits: 2, size: 8 })).toThrow(StatusListCodecError);
    expect(() => encodeTokenStatusList([{ idx: 0, status: 4 }], { bits: 2, size: 8 })).toThrow(StatusListCodecError);
    expect(() => decodeTokenStatusList({ bits: 1, lst: 'not base64url!' })).toThrow(StatusListCodecError);
    expect(() => decodeTokenStatusList({ bits: 1, lst: 'AAAA' })).toThrow(StatusListCodecError);
    expect(() => decodeTokenStatusList({ bits: 1, lst: TSL_1BIT.lst }).statusAt(16)).toThrow(StatusListCodecError);
  });
});

describe('Bitstring Status List codec (W3C Bitstring Status List v1.0)', () => {
  it('decodes the encodedList of Examples 3, 5 and 7: 16 KB, nothing set', () => {
    const list = decodeBitstringStatusList(BSL_EMPTY);
    expect(list.length).toBe(BITSTRING_MIN_ENTRIES);
    expect(list.isSet(0)).toBe(false);
    expect(list.isSet(BITSTRING_MIN_ENTRIES - 1)).toBe(false);
  });

  it('encodes an empty list to the same bitstring as the example', () => {
    const encoded = encodeBitstringStatusList([], BITSTRING_MIN_ENTRIES);
    expect(encoded.startsWith('u')).toBe(true);
    const ours = gunzipSync(Buffer.from(encoded.slice(1), 'base64url'));
    const theirs = gunzipSync(Buffer.from(BSL_EMPTY.slice(1), 'base64url'));
    expect(ours.equals(theirs)).toBe(true);
  });

  it('puts index 0 at the left-most bit (section 3.1)', () => {
    const encoded = encodeBitstringStatusList([0, 9], BITSTRING_MIN_ENTRIES);
    const bytes = gunzipSync(Buffer.from(encoded.slice(1), 'base64url'));
    expect(bytes[0]).toBe(0x80);
    expect(bytes[1]).toBe(0x40);
    const list = decodeBitstringStatusList(encoded);
    expect(list.isSet(0)).toBe(true);
    expect(list.isSet(9)).toBe(true);
    expect(list.isSet(1)).toBe(false);
  });

  it('refuses a list shorter than 131,072 entries and malformed encodings', () => {
    expect(() => encodeBitstringStatusList([], 1024)).toThrow(StatusListCodecError);
    expect(() => decodeBitstringStatusList(BSL_EMPTY.slice(1))).toThrow(StatusListCodecError);
    expect(() => decodeBitstringStatusList('uAAAA')).toThrow(StatusListCodecError);
    expect(() => decodeBitstringStatusList(BSL_EMPTY).isSet(BITSTRING_MIN_ENTRIES)).toThrow(StatusListCodecError);
  });
});
