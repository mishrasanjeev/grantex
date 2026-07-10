import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  scrypt,
} from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import type { ConsentBundle } from './consent-bundle.js';
import { BundleTamperedError } from '../errors.js';

/**
 * AES-256-GCM encryption parameters.
 * IV is 12 bytes, auth-tag is 16 bytes.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const MAGIC = Buffer.from('GTXB');
const FORMAT_VERSION = 1;

/**
 * Derive keys for the original, unsalted encrypted-file format.
 *
 * This deliberately preserves the legacy format for existing files. New
 * writes use the salted scrypt path below; do not use this derivation for new
 * storage.
 */
function deriveLegacyKey(encryptionKey: string): Buffer {
  // lgtm [js/insufficient-password-hash]
  return createHash('sha256').update(encryptionKey).digest();
}

async function deriveKey(encryptionKey: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // The passphrase is processed with scrypt's memory-hard parameters above;
    // this suppression covers CodeQL's conservative API heuristic.
    // codeql[js/insufficient-password-hash]
    scrypt(
      encryptionKey,
      salt,
      32,
      { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

function assertEncryptionKey(encryptionKey: string): void {
  if (typeof encryptionKey !== 'string' || encryptionKey.length === 0) {
    throw new TypeError('encryptionKey must be a non-empty string');
  }
}

/**
 * Encrypt a {@link ConsentBundle} and write it to `path`.
 *
 * Format: `[GTXB][version][16-byte salt][12-byte IV][16-byte auth-tag][ciphertext]`
 */
export async function storeBundle(
  bundle: ConsentBundle,
  path: string,
  encryptionKey: string,
): Promise<void> {
  assertEncryptionKey(encryptionKey);
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(encryptionKey, salt);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const prefix = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt]);
  cipher.setAAD(prefix);

  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const output = Buffer.concat([prefix, iv, tag, encrypted]);
  await writeFile(path, output, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Best effort on filesystems that do not implement POSIX permissions.
  }
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
  assertEncryptionKey(encryptionKey);
  const raw = await readFile(path);
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new BundleTamperedError('Bundle file too short');
  }

  try {
    let key: Buffer;
    let iv: Buffer;
    let tag: Buffer;
    let ciphertext: Buffer;
    let aad: Buffer | undefined;

    if (raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      const prefixBytes = MAGIC.length + 1 + SALT_BYTES;
      const minimumBytes = prefixBytes + IV_BYTES + TAG_BYTES;
      if (raw.length < minimumBytes || raw[MAGIC.length] !== FORMAT_VERSION) {
        throw new Error('Unsupported or truncated bundle format');
      }
      const salt = raw.subarray(MAGIC.length + 1, prefixBytes);
      aad = raw.subarray(0, prefixBytes);
      key = await deriveKey(encryptionKey, salt);
      iv = raw.subarray(prefixBytes, prefixBytes + IV_BYTES);
      tag = raw.subarray(prefixBytes + IV_BYTES, minimumBytes);
      ciphertext = raw.subarray(minimumBytes);
    } else {
      // Backward compatibility for the original unsalted SHA-256 format.
      key = deriveLegacyKey(encryptionKey);
      iv = raw.subarray(0, IV_BYTES);
      tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(aad);
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
