/**
 * Approver personal data at rest. Emails are stored only as a keyed hash
 * (enough to tell two approvers apart for four eyes, not to recover the
 * address); display names are encrypted with the vault key.
 */
import { createHash, createHmac } from 'node:crypto';
import { config } from '../../config.js';
import { decrypt, encrypt } from '../vault-crypto.js';

function hmacKey(): Buffer {
  const key = config.vaultEncryptionKey;
  if (!key) throw new Error('VAULT_ENCRYPTION_KEY is not configured');
  return createHash('sha256').update(`grantex:decision-approver-email:${key}`).digest();
}

/** `hmac-sha256:<base64url>` of the lower-cased email. */
export function approverEmailHash(email: string): string {
  return `hmac-sha256:${createHmac('sha256', hmacKey()).update(email.trim().toLowerCase(), 'utf8').digest('base64url')}`;
}

export function encryptApproverName(name: string): string {
  return encrypt(name);
}

/** The display name, or undefined when it cannot be decrypted. */
export function decryptApproverName(ciphertext: string | null): string | undefined {
  if (!ciphertext) return undefined;
  try {
    return decrypt(ciphertext);
  } catch {
    return undefined;
  }
}
