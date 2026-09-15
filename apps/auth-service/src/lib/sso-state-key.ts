import { createHash, hkdfSync, randomBytes } from 'node:crypto';

export interface SsoStateKeySettings {
  ssoStateSecret: string | null;
  rsaPrivateKey: string | null;
  ecPrivateKey: string | null;
  vaultEncryptionKey: string | null;
}

let ephemeralSsoStateSecret: string | null = null;

function vaultKeyBytes(value: string): Buffer | null {
  const decoded = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  return decoded.length === 32 ? decoded : null;
}

/**
 * The HMAC key for SSO state. Every instance must derive the same key, so it
 * comes from a persistent secret, in this order:
 *
 * 1. `SSO_STATE_SECRET`;
 * 2. a hash of `RSA_PRIVATE_KEY`, then of `EC_PRIVATE_KEY` (unchanged for
 *    existing RS256 deployments);
 * 3. HKDF-SHA256 of `VAULT_ENCRYPTION_KEY` (for example with the postgres
 *    signing-key store, where no private key is configured).
 *
 * With none of these, production throws; elsewhere a per-process random key
 * is used, so SSO state does not survive a restart or cross instances.
 */
export function deriveSsoStateKey(settings: SsoStateKeySettings, nodeEnv: string | undefined): string {
  if (settings.ssoStateSecret) return settings.ssoStateSecret;
  const configuredPrivateKey = settings.rsaPrivateKey ?? settings.ecPrivateKey;
  if (configuredPrivateKey) {
    return createHash('sha256').update(configuredPrivateKey).digest('hex');
  }
  const vaultKey = settings.vaultEncryptionKey ? vaultKeyBytes(settings.vaultEncryptionKey) : null;
  if (vaultKey !== null) {
    return Buffer.from(hkdfSync('sha256', vaultKey, Buffer.alloc(0), 'grantex:sso-state:v1', 32)).toString('hex');
  }
  if (nodeEnv === 'production') {
    throw new Error('SSO state needs SSO_STATE_SECRET, a configured private key or VAULT_ENCRYPTION_KEY in production');
  }
  ephemeralSsoStateSecret ??= randomBytes(32).toString('hex');
  return ephemeralSsoStateSecret;
}
