/**
 * DID:key utilities for Ed25519 keys.
 *
 * A did:key for Ed25519 is encoded as:
 *   did:key:z<base58btc(multicodec_header + public_key)>
 *
 * The multicodec header for Ed25519 public keys is [0xed, 0x01].
 */

// Ed25519 multicodec prefix
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

// Base58btc alphabet (Bitcoin)
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes to base58btc.
 */
export function base58btcEncode(bytes: Uint8Array): string {
  // Count leading zeros
  let zeroes = 0;
  for (const b of bytes) {
    if (b !== 0) break;
    zeroes++;
  }

  // Convert to big integer
  let num = 0n;
  for (const b of bytes) {
    num = num * 256n + BigInt(b);
  }

  // Encode
  const chars: string[] = [];
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    chars.unshift(BASE58_ALPHABET[Number(remainder)]!);
  }

  // Add leading '1's for leading zero bytes
  for (let i = 0; i < zeroes; i++) {
    chars.unshift('1');
  }

  return chars.join('');
}

/**
 * Decode base58btc string to bytes.
 */
export function base58btcDecode(str: string): Uint8Array {
  // Count leading '1's
  let zeroes = 0;
  for (const c of str) {
    if (c !== '1') break;
    zeroes++;
  }

  // Decode to big integer
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }

  // Convert to bytes
  const hex = num === 0n ? '' : num.toString(16).padStart(2, '0');
  const paddedHex = hex.length % 2 ? '0' + hex : hex;
  const decoded = new Uint8Array(paddedHex.length / 2);
  for (let i = 0; i < decoded.length; i++) {
    decoded[i] = parseInt(paddedHex.slice(i * 2, i * 2 + 2), 16);
  }

  // Prepend leading zero bytes
  const result = new Uint8Array(zeroes + decoded.length);
  result.set(decoded, zeroes);
  return result;
}

/**
 * Convert a 32-byte Ed25519 public key to a did:key string.
 */
export function publicKeyToDID(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const multicodecKey = new Uint8Array(ED25519_MULTICODEC.length + publicKey.length);
  multicodecKey.set(ED25519_MULTICODEC);
  multicodecKey.set(publicKey, ED25519_MULTICODEC.length);
  return `did:key:z${base58btcEncode(multicodecKey)}`;
}

/**
 * Extract the 32-byte Ed25519 public key from a did:key string.
 */
export function didToPublicKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error(`Unsupported DID format: ${did}. Only did:key is supported.`);
  }

  const multicodecKey = base58btcDecode(did.slice(9)); // skip "did:key:z" (9 chars)

  if (multicodecKey[0] !== 0xed || multicodecKey[1] !== 0x01) {
    throw new Error('DID does not encode an Ed25519 public key');
  }

  return multicodecKey.slice(2);
}

/**
 * Validate that a string is a well-formed did:key for Ed25519.
 */
export function isValidDID(did: string): boolean {
  try {
    didToPublicKey(did);
    return true;
  } catch {
    return false;
  }
}
