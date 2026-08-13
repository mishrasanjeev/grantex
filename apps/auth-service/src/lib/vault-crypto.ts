import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

const KEY_LENGTH = 32; // AES-256

function getKey(): Buffer {
  const key = config.vaultEncryptionKey;
  if (!key) {
    throw new Error('VAULT_ENCRYPTION_KEY is not configured');
  }
  // Support both hex (64 chars) and base64 (44 chars) formats
  const decoded = /^[0-9a-fA-F]{64}$/.test(key)
    ? Buffer.from(key, 'hex')
    : Buffer.from(key, 'base64');

  // Buffer.from silently drops characters it cannot decode, so a truncated or
  // mistyped key yields a short buffer rather than an error. Checking the
  // length here fails with something that names the problem, instead of
  // createCipheriv's generic "Invalid key length".
  if (decoded.length !== KEY_LENGTH) {
    throw new Error(
      `VAULT_ENCRYPTION_KEY must decode to ${KEY_LENGTH} bytes (got ${decoded.length}); `
      + 'supply 64 hex characters or 44 base64 characters',
    );
  }
  return decoded;
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: base64(iv + tag + ciphertext)
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const data = Buffer.from(ciphertext, 'base64');

  // Without this, a truncated value produces short IV/tag slices and surfaces
  // as an opaque error from createDecipheriv or setAuthTag.
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Ciphertext is too short to contain an IV and auth tag');
  }

  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  // Concatenate as bytes, then decode once.
  //
  // `decipher.update(buf) + decipher.final('utf8')` relied on Buffer's implicit
  // toString() and decoded each part separately. That happens to work for GCM,
  // which is a stream cipher and never withholds a partial block — but any
  // mode that buffers would split a multi-byte character across the two calls
  // and each half would decode to U+FFFD. Decoding the joined bytes has no such
  // dependency on the cipher's internals.
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
