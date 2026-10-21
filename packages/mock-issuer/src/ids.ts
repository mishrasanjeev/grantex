// SPDX-License-Identifier: Apache-2.0
//
// ULIDs: a 48-bit millisecond timestamp and 80 random bits, written as 26
// characters of Crockford's base32 (the ULID specification's layout, the one
// the registry uses for its own identifiers).

import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs: number = Date.now()): string {
  let time = '';
  let t = Math.floor(nowMs);
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits: 16 characters of 5 bits each.
  const random = randomBytes(10);
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let tail = '';
  for (let i = 0; i < 16; i += 1) {
    tail = CROCKFORD[Number(bits & 31n)]! + tail;
    bits >>= 5n;
  }
  return time + tail;
}

/** An attestation identifier minted by the issuer: att_<ulid>. */
export function newAttestationId(): string {
  return `att_${ulid()}`;
}

/** The issuer's own identifier for an issued passport, carried as external_credential_id. */
export function newPassportId(): string {
  return `ppt_${ulid()}`;
}
