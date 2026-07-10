import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';

export interface SignedOfflineAuditEntry {
  seq: number;
  timestamp: string;
  action: string;
  agentDID: string;
  grantId: string;
  scopes: string[];
  result: string;
  metadata?: Record<string, unknown>;
  prevHash: string;
  hash: string;
  signature: string;
}

export const OFFLINE_AUDIT_GENESIS_HASH = '0000000000000000';

/**
 * Keep this byte-for-byte compatible with @grantex/gemma's
 * computeEntryHash implementation.
 */
export function computeOfflineAuditEntryHash(
  entry: Omit<SignedOfflineAuditEntry, 'hash' | 'signature'>,
): string {
  const hash = createHash('sha256');
  hash.update(String(entry.seq));
  hash.update('|');
  hash.update(entry.timestamp);
  hash.update('|');
  hash.update(entry.action);
  hash.update('|');
  hash.update(entry.agentDID);
  hash.update('|');
  hash.update(entry.grantId);
  hash.update('|');
  hash.update(entry.scopes.join(','));
  hash.update('|');
  hash.update(entry.result);
  hash.update('|');
  hash.update(entry.metadata !== undefined ? JSON.stringify(entry.metadata) : '');
  hash.update('|');
  hash.update(entry.prevHash);
  return hash.digest('hex');
}

export function verifyOfflineAuditEntrySignature(
  entry: SignedOfflineAuditEntry,
  publicJwk: string | object,
): boolean {
  if (!/^[0-9a-f]{128}$/i.test(entry.signature)) return false;

  try {
    const parsed: object = typeof publicJwk === 'string'
      ? JSON.parse(publicJwk) as object
      : publicJwk;
    const publicKey = createPublicKey({ key: parsed as never, format: 'jwk' });
    return cryptoVerify(
      null,
      Buffer.from(entry.hash, 'utf8'),
      publicKey,
      Buffer.from(entry.signature, 'hex'),
    );
  } catch {
    return false;
  }
}
