// SPDX-License-Identifier: Apache-2.0
/**
 * The two status-list encodings the registry publishes its attestation
 * acceptance in, checked against the example vectors their specifications
 * give.
 *
 * - Token Status List (draft-ietf-oauth-status-list-21): §4.1 packs entries
 *   from the least significant bit of each byte, compresses with DEFLATE in
 *   the ZLIB format, and §4.2 base64url-encodes the result as `lst`.
 *   Appendix C gives 2^20-entry vectors.
 * - Bitstring Status List v1.0 (W3C Recommendation): §2.2 puts index 0 at the
 *   left-most bit, compresses with GZIP and multibase-encodes the result as
 *   base64url with no padding (`u` prefix); §3.2 refuses a list shorter than
 *   131,072 entries.
 *
 * The two bit orders are opposite, which is why each encoder is tested on
 * the same statuses and why neither output is ever derived from the other.
 */
import { gunzipSync, gzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_LIST_CAPACITY,
  BITSTRING_MIN_ENTRIES,
  StatusListCodecError,
  TOKEN_STATUS,
  decodeBitstringStatusList,
  decodeTokenStatusList,
  encodeBitstringStatusList,
  encodeTokenStatusList,
} from '../src/lib/registry/status-list-codec.js';

/** draft-ietf-oauth-status-list-21 §4.1 and §4.2, bits = 1. */
const TSL_BITS1_BYTES = [0xb9, 0xa3];
const TSL_BITS1_LST = 'eNrbuRgAAhcBXQ';
const TSL_BITS1_ZLIB_HEX = '78dadbb918000217015d';
const TSL_BITS1_STATUSES = [1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1];

/** draft-ietf-oauth-status-list-21 §4.1 and §4.2, bits = 2. */
const TSL_BITS2_BYTES = [0xc9, 0x44, 0xf9];
const TSL_BITS2_LST = 'eNo76fITAAPfAgc';
const TSL_BITS2_STATUSES = [1, 2, 0, 3, 0, 1, 0, 1, 1, 2, 3, 3];

/** draft-ietf-oauth-status-list-21 Appendix C.1: 1-bit list of 2^20 entries. */
const TSL_C1_LST = 'eNrt3AENwCAMAEGogklACtKQPg9LugC9k_ACvreiogE'
  + 'AAKkeCQAAAAAAAAAAAAAAAAAAAIBylgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAXG9IAAAAAAAAAPwsJAAAAAAAAAAAAAAAvhsSAAAAAAAAAAA'
  + 'A7KpLAAAAAAAAAAAAAAAAAAAAAJsLCQAAAAAAAAAAADjelAAAAAAAAAAAKjDMAQAAA'
  + 'ACAZC8L2AEb';
const TSL_C1_SET: Array<[number, number]> = [
  [0, 1], [1993, 1], [25460, 1], [159495, 1], [495669, 1], [554353, 1],
  [645645, 1], [723232, 1], [854545, 1], [934534, 1], [1000345, 1],
];

/** draft-ietf-oauth-status-list-21 Appendix C.2: 2-bit list of 2^20 entries. */
const TSL_C2_LST = 'eNrt2zENACEQAEEuoaBABP5VIO01fCjIHTMStt9ovGV'
  + 'IAAAAAABAbiEBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEB5WwIAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAID0ugQAAAAAAAAAAAAAAAAAQG12SgAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAOCSIQEAAAAAAAAAAAAAAAAAAAAAAAD8ExIAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwJEuAQAAAAAAAAAAAAAAAAAAAAAAAMB9S'
  + 'wIAAAAAAAAAAAAAAAAAAACoYUoAAAAAAAAAAAAAAEBqH81gAQw';
const TSL_C2_SET: Array<[number, number]> = [
  [0, 1], [1993, 2], [25460, 1], [159495, 3], [495669, 1], [554353, 1],
  [645645, 2], [723232, 1], [854545, 1], [934534, 2], [1000345, 3],
];

/**
 * Bitstring Status List v1.0 §2.2 Example 3: the encodedList of an empty
 * 131,072-entry revocation list.
 */
const BSL_EXAMPLE3_ENCODED = 'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA';

describe('Token Status List encoding (draft-ietf-oauth-status-list-21 §4)', () => {
  it('reproduces the §4.1 byte arrays and the §4.2 lst values exactly', () => {
    const one = encodeTokenStatusList(
      TSL_BITS1_STATUSES.map((status, idx) => ({ idx, status })),
      { bits: 1, size: 16 },
    );
    expect(one).toBe(TSL_BITS1_LST);
    expect(Buffer.from(one, 'base64url').toString('hex')).toBe(TSL_BITS1_ZLIB_HEX);
    expect([...inflateSync(Buffer.from(one, 'base64url'))]).toEqual(TSL_BITS1_BYTES);

    const two = encodeTokenStatusList(
      TSL_BITS2_STATUSES.map((status, idx) => ({ idx, status })),
      { bits: 2, size: 12 },
    );
    expect(two).toBe(TSL_BITS2_LST);
    expect([...inflateSync(Buffer.from(two, 'base64url'))]).toEqual(TSL_BITS2_BYTES);
  });

  it('decodes the §4.2 examples to the statuses §4.1 lists', () => {
    const one = decodeTokenStatusList({ bits: 1, lst: TSL_BITS1_LST });
    expect(one.size).toBe(16);
    expect(TSL_BITS1_STATUSES.map((_, idx) => one.statusAt(idx))).toEqual(TSL_BITS1_STATUSES);

    const two = decodeTokenStatusList({ bits: 2, lst: TSL_BITS2_LST });
    expect(two.size).toBe(12);
    expect(TSL_BITS2_STATUSES.map((_, idx) => two.statusAt(idx))).toEqual(TSL_BITS2_STATUSES);
  });

  it.each([
    ['C.1 (1 bit)', 1, TSL_C1_LST, TSL_C1_SET],
    ['C.2 (2 bits)', 2, TSL_C2_LST, TSL_C2_SET],
  ] as const)('decodes the Appendix %s vector and round-trips it', (_name, bits, lst, set) => {
    const decoded = decodeTokenStatusList({ bits, lst });
    expect(decoded.size).toBe(2 ** 20);
    for (const [idx, status] of set) expect(decoded.statusAt(idx)).toBe(status);
    // Every index the vector does not mention is 0 (VALID).
    const mentioned = new Set(set.map(([idx]) => idx));
    let nonZero = 0;
    for (let idx = 0; idx < decoded.size; idx++) {
      if (decoded.statusAt(idx) !== 0) {
        nonZero++;
        expect(mentioned.has(idx)).toBe(true);
      }
    }
    expect(nonZero).toBe(set.length);

    // Compressors may choose different DEFLATE blocks, so the encoding is
    // compared after inflation: the byte arrays must be identical.
    const ours = encodeTokenStatusList(set.map(([idx, status]) => ({ idx, status })), { bits, size: 2 ** 20 });
    expect(inflateSync(Buffer.from(ours, 'base64url')).equals(inflateSync(Buffer.from(lst, 'base64url')))).toBe(true);
  });

  it('uses the §7.1 status type values', () => {
    expect(TOKEN_STATUS).toEqual({ VALID: 0x00, INVALID: 0x01, SUSPENDED: 0x02 });
  });

  it('packs from the least significant bit: index 0 INVALID is 0x01, index 3 SUSPENDED is 0x80', () => {
    const lst = encodeTokenStatusList(
      [{ idx: 0, status: TOKEN_STATUS.INVALID }, { idx: 3, status: TOKEN_STATUS.SUSPENDED }],
      { bits: 2, size: 8 },
    );
    expect([...inflateSync(Buffer.from(lst, 'base64url'))]).toEqual([0x81, 0x00]);
  });

  it('refuses a status that does not fit, an index out of range, and an unsupported bits value', () => {
    expect(() => encodeTokenStatusList([{ idx: 0, status: 4 }], { bits: 2, size: 8 })).toThrow(StatusListCodecError);
    expect(() => encodeTokenStatusList([{ idx: 8, status: 1 }], { bits: 2, size: 8 })).toThrow(StatusListCodecError);
    expect(() => encodeTokenStatusList([{ idx: -1, status: 1 }], { bits: 2, size: 8 })).toThrow(StatusListCodecError);
    expect(() => encodeTokenStatusList([], { bits: 3 as 1, size: 8 })).toThrow(StatusListCodecError);
  });

  it('refuses to answer for an index outside the list (§8.3 step 6)', () => {
    const decoded = decodeTokenStatusList({ bits: 2, lst: TSL_BITS2_LST });
    expect(() => decoded.statusAt(12)).toThrow(StatusListCodecError);
    expect(() => decoded.statusAt(-1)).toThrow(StatusListCodecError);
    expect(() => decoded.statusAt(1.5)).toThrow(StatusListCodecError);
  });

  it('refuses an lst that is not ZLIB data', () => {
    expect(() => decodeTokenStatusList({ bits: 1, lst: 'bm90IHpsaWI' })).toThrow(StatusListCodecError);
  });
});

describe('Bitstring Status List encoding (W3C Bitstring Status List v1.0 §2.2, §3.3, §3.4)', () => {
  it('decodes the §2.2 Example 3 encodedList to 131,072 unset entries', () => {
    const decoded = decodeBitstringStatusList(BSL_EXAMPLE3_ENCODED);
    expect(decoded.length).toBe(131_072);
    for (const idx of [0, 1, 94_567, 131_071]) expect(decoded.isSet(idx)).toBe(false);
  });

  it('encodes an empty list to the same bitstring as Example 3', () => {
    const ours = encodeBitstringStatusList([], BITSTRING_MIN_ENTRIES);
    expect(ours.startsWith('u')).toBe(true);
    expect(ours).not.toContain('=');
    const bits = gunzipSync(Buffer.from(ours.slice(1), 'base64url'));
    expect(bits.equals(gunzipSync(Buffer.from(BSL_EXAMPLE3_ENCODED.slice(1), 'base64url')))).toBe(true);
  });

  it('puts index 0 at the left-most bit (§2.2, §7.1)', () => {
    const encoded = encodeBitstringStatusList([0, 9], BITSTRING_MIN_ENTRIES);
    const bits = gunzipSync(Buffer.from(encoded.slice(1), 'base64url'));
    expect(bits[0]).toBe(0x80);
    expect(bits[1]).toBe(0x40);
  });

  it('round-trips a set of indices across the whole list', () => {
    const set = [0, 1, 7, 8, 94_567, 23_452, 131_071];
    const decoded = decodeBitstringStatusList(encodeBitstringStatusList(set, ACCEPTANCE_LIST_CAPACITY));
    expect(decoded.length).toBe(ACCEPTANCE_LIST_CAPACITY);
    for (const idx of set) expect(decoded.isSet(idx)).toBe(true);
    for (const idx of [2, 6, 9, 94_566, 131_070]) expect(decoded.isSet(idx)).toBe(false);
  });

  it('refuses a list shorter than 131,072 entries, in either direction (§3.2)', () => {
    expect(() => encodeBitstringStatusList([], 131_064)).toThrow(StatusListCodecError);
    const short = `u${gzipSync(Buffer.alloc(1024)).toString('base64url')}`;
    expect(() => decodeBitstringStatusList(short)).toThrow(StatusListCodecError);
  });

  it('refuses an encodedList without the base64url multibase prefix, or not GZIP data', () => {
    expect(() => decodeBitstringStatusList(BSL_EXAMPLE3_ENCODED.slice(1))).toThrow(StatusListCodecError);
    expect(() => decodeBitstringStatusList('uAAAA')).toThrow(StatusListCodecError);
  });

  it('refuses an index outside the list', () => {
    expect(() => encodeBitstringStatusList([131_072], BITSTRING_MIN_ENTRIES)).toThrow(StatusListCodecError);
    const decoded = decodeBitstringStatusList(BSL_EXAMPLE3_ENCODED);
    expect(() => decoded.isSet(131_072)).toThrow(StatusListCodecError);
  });
});

describe('acceptance list capacity', () => {
  it('holds at least the 131,072 entries Bitstring Status List §3.2 requires', () => {
    expect(ACCEPTANCE_LIST_CAPACITY).toBeGreaterThanOrEqual(131_072);
    expect(ACCEPTANCE_LIST_CAPACITY % 8).toBe(0);
    // Two bits per entry in the Token Status List: 32 KiB uncompressed.
    const lst = encodeTokenStatusList([{ idx: ACCEPTANCE_LIST_CAPACITY - 1, status: 2 }], {
      bits: 2, size: ACCEPTANCE_LIST_CAPACITY,
    });
    const decoded = decodeTokenStatusList({ bits: 2, lst });
    expect(decoded.size).toBe(ACCEPTANCE_LIST_CAPACITY);
    expect(decoded.statusAt(ACCEPTANCE_LIST_CAPACITY - 1)).toBe(2);
  });
});
