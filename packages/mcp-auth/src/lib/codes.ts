import { randomBytes } from 'node:crypto';

/** 256 bits of randomness, base64url encoded. Used for codes, ids and CSRF tokens. */
export function generateCode(): string {
  return randomBytes(32).toString('base64url');
}
