import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { ConsentBundle } from './consent-bundle.js';
import { BundleTamperedError } from '../errors.js';

/**
 * AES-256-GCM encryption parameters.
 * IV is 12 bytes, auth-tag is 16 bytes.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derive a 32-byte AES key from the user-supplied encryption key
 * via SHA-256 (allows arbitrary-length passphrases).
 */
function deriveKey(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey).digest();
}

/**
 * Encrypt a {@link ConsentBundle} and write it to `path`.
 *
 * Format: `[12-byte IV][16-byte auth-tag][ciphertext]`
 */
export async function storeBundle(
  bundle: ConsentBundle,
  path: string,
  encryptionKey: string,
): Promise<void> {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const output = Buffer.concat([iv, tag, encrypted]);
  await writeFile(path, output);
}

/**
 * Read and decrypt a {@link ConsentBundle} from `path`.
 *
 * @throws {@link BundleTamperedError} if decryption or integrity check fails.
 */
export async function loadBundle(
  path: string,
  encryptionKey: string,
): Promise<ConsentBundle> {
  const raw = await readFile(path);
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new BundleTamperedError('Bundle file too short');
  }

  const key = deriveKey(encryptionKey);
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf-8')) as ConsentBundle;
  } catch {
    throw new BundleTamperedError();
  }
}
