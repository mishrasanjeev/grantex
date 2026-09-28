// SPDX-License-Identifier: Apache-2.0
//
// Encoders and decoders for the two status-list formats the mock issuer
// publishes its passport statuses in. The auth service has the same codec
// for the registry's own lists (apps/auth-service/src/lib/registry/
// status-list-codec.ts); a package cannot import the service, so the rules
// are repeated here and both are tested against the specifications' examples.
//
// - Token Status List, draft-ietf-oauth-status-list-21. Section 4.1: each
//   entry is `bits` wide, entries are packed from the least significant bit
//   of each byte, and the byte array is compressed with DEFLATE (RFC 1951) in
//   the ZLIB format (RFC 1950). Section 4.2: `lst` is its base64url encoding.
// - Bitstring Status List v1.0, W3C Recommendation. Section 3.1: index 0 is
//   the left-most bit, the bitstring is GZIP (RFC 1952) compressed and
//   multibase-encoded as base64url with no padding (prefix `u`), and it is at
//   least 16 KB, 131,072 entries (section 3.2 refuses a shorter list).
//
// The bit orders are opposite. Nothing here converts one format into the
// other: each encoder takes the statuses themselves.
//
// Every decoder throws rather than guessing: a list that cannot be decoded
// must never read as "not revoked".

import { deflateSync, gunzipSync, gzipSync, inflateSync } from 'node:zlib';

/** draft-ietf-oauth-status-list-21 section 7.1 status type values. */
export const TOKEN_STATUS = Object.freeze({ VALID: 0x00, INVALID: 0x01, SUSPENDED: 0x02 } as const);

/** Bitstring Status List v1.0 section 3.2: the minimum number of entries (16 KB). */
export const BITSTRING_MIN_ENTRIES = 131_072;

/** draft-ietf-oauth-status-list-21 section 4.1: the allowed widths. */
export type TokenStatusBits = 1 | 2 | 4 | 8;

const TOKEN_STATUS_BITS: readonly number[] = [1, 2, 4, 8];

/** Bitstring Status List v1.0 section 2.2: multibase prefix for base64url without padding. */
const MULTIBASE_BASE64URL = 'u';

/** Upper bound on an inflated list, so a hostile list cannot exhaust memory. */
const MAX_DECODED_BYTES = 16 * 1024 * 1024;

export class StatusListCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusListCodecError';
  }
}

export interface StatusEntry {
  idx: number;
  status: number;
}

function assertIndex(idx: number, size: number): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= size) {
    throw new StatusListCodecError(`index ${idx} is outside a list of ${size} entries`);
  }
}

function assertBits(bits: number): asserts bits is TokenStatusBits {
  if (!TOKEN_STATUS_BITS.includes(bits)) {
    throw new StatusListCodecError(`bits must be 1, 2, 4 or 8, not ${bits}`);
  }
}

/**
 * Build `lst` (draft-ietf-oauth-status-list-21 sections 4.1 and 4.2) for
 * `size` entries of `bits` each. Entries not given are 0x00 VALID.
 */
export function encodeTokenStatusList(
  entries: Iterable<StatusEntry>,
  options: { bits: TokenStatusBits; size: number },
): string {
  const { bits, size } = options;
  assertBits(bits);
  if (!Number.isInteger(size) || size <= 0) throw new StatusListCodecError(`size must be a positive integer, not ${size}`);
  const perByte = 8 / bits;
  const bytes = Buffer.alloc(Math.ceil(size / perByte));
  const max = (1 << bits) - 1;
  for (const { idx, status } of entries) {
    assertIndex(idx, size);
    if (!Number.isInteger(status) || status < 0 || status > max) {
      throw new StatusListCodecError(`status ${status} does not fit in ${bits} bit(s)`);
    }
    const byte = Math.floor(idx / perByte);
    const shift = (idx % perByte) * bits;
    // Section 4.1 step 3: entries are packed from the least significant bit.
    bytes[byte] = (bytes[byte]! & ~(max << shift)) | (status << shift);
  }
  // Section 4.1 step 4: DEFLATE with the ZLIB format, highest compression.
  return deflateSync(bytes, { level: 9 }).toString('base64url');
}

export interface DecodedTokenStatusList {
  bits: TokenStatusBits;
  /** Number of entries the byte array holds. */
  size: number;
  /** Throws for an index out of bounds rather than answering (section 8.3 step 6). */
  statusAt(idx: number): number;
}

/** Read a section 4.2 StatusList object. Throws on anything malformed. */
export function decodeTokenStatusList(statusList: { bits: number; lst: string }): DecodedTokenStatusList {
  const { bits, lst } = statusList;
  assertBits(bits);
  if (typeof lst !== 'string' || !/^[A-Za-z0-9_-]+$/.test(lst)) {
    throw new StatusListCodecError('lst must be a base64url string');
  }
  let bytes: Buffer;
  try {
    // Section 8.3 step 5: a decompressor compatible with DEFLATE and ZLIB.
    bytes = inflateSync(Buffer.from(lst, 'base64url'), { maxOutputLength: MAX_DECODED_BYTES });
  } catch (err) {
    throw new StatusListCodecError(`lst is not ZLIB data: ${(err as Error).message}`);
  }
  const perByte = 8 / bits;
  const size = bytes.length * perByte;
  const max = (1 << bits) - 1;
  return {
    bits,
    size,
    statusAt(idx: number): number {
      assertIndex(idx, size);
      const byte = bytes[Math.floor(idx / perByte)]!;
      return (byte >> ((idx % perByte) * bits)) & max;
    },
  };
}

/**
 * Build `encodedList` (Bitstring Status List v1.0 sections 2.2 and 3.1) of
 * `length` one-bit entries with the given indices set.
 */
export function encodeBitstringStatusList(setIndices: Iterable<number>, length: number): string {
  if (!Number.isInteger(length) || length < BITSTRING_MIN_ENTRIES || length % 8 !== 0) {
    throw new StatusListCodecError(
      `a bitstring status list holds a multiple of 8 and at least ${BITSTRING_MIN_ENTRIES} entries, not ${length}`,
    );
  }
  const bytes = Buffer.alloc(length / 8);
  for (const idx of setIndices) {
    assertIndex(idx, length);
    // Section 3.1: index 0 is the left-most (most significant) bit.
    bytes[idx >> 3] = bytes[idx >> 3]! | (0x80 >> (idx & 7));
  }
  return MULTIBASE_BASE64URL + gzipSync(bytes, { level: 9 }).toString('base64url');
}

export interface DecodedBitstringStatusList {
  /** Number of one-bit entries. */
  length: number;
  /** Throws for an index outside the list (section 3.2 RANGE_ERROR). */
  isSet(idx: number): boolean;
}

/** Read an `encodedList` (Bitstring Status List v1.0 section 3.2). Throws on anything malformed. */
export function decodeBitstringStatusList(encodedList: string): DecodedBitstringStatusList {
  if (
    typeof encodedList !== 'string' ||
    !encodedList.startsWith(MULTIBASE_BASE64URL) ||
    !/^[A-Za-z0-9_-]+$/.test(encodedList.slice(1))
  ) {
    throw new StatusListCodecError('encodedList must be multibase base64url (prefix "u", no padding)');
  }
  let bytes: Buffer;
  try {
    bytes = gunzipSync(Buffer.from(encodedList.slice(1), 'base64url'), { maxOutputLength: MAX_DECODED_BYTES });
  } catch (err) {
    throw new StatusListCodecError(`encodedList is not GZIP data: ${(err as Error).message}`);
  }
  const length = bytes.length * 8;
  // Section 3.2 STATUS_LIST_LENGTH_ERROR.
  if (length < BITSTRING_MIN_ENTRIES) {
    throw new StatusListCodecError(`status list holds ${length} entries, fewer than ${BITSTRING_MIN_ENTRIES}`);
  }
  return {
    length,
    isSet(idx: number): boolean {
      assertIndex(idx, length);
      return (bytes[idx >> 3]! & (0x80 >> (idx & 7))) !== 0;
    },
  };
}
