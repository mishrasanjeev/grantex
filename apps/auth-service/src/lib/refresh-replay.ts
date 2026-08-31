import type { TxSql } from '../db/client.js';
import { decrypt, encrypt } from './vault-crypto.js';

const ENCRYPTED_REPLAY_PREFIX = 'enc:v1:';

export function sealRefreshReplayToken(token: string): string {
  if (token.length === 0) throw new Error('Refresh replay token must not be empty');
  return `${ENCRYPTED_REPLAY_PREFIX}${encrypt(token)}`;
}

export function openRefreshReplayToken(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(ENCRYPTED_REPLAY_PREFIX)) return null;
  try {
    const token = decrypt(value.slice(ENCRYPTED_REPLAY_PREFIX.length));
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function clearRefreshReplayState(sql: TxSql, refreshTokenId: string): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET replay_expires_at = NULL,
        replay_request_hash = NULL,
        replay_jti = NULL,
        replay_issued_at = NULL,
        replay_grant_token = NULL
    WHERE id = ${refreshTokenId}
  `;
}

export async function clearExpiredRefreshReplayState(sql: TxSql): Promise<void> {
  await sql`
    UPDATE refresh_tokens
    SET replay_expires_at = NULL,
        replay_request_hash = NULL,
        replay_jti = NULL,
        replay_issued_at = NULL,
        replay_grant_token = NULL
    WHERE replay_expires_at IS NOT NULL
      AND replay_expires_at <= NOW()
  `;
}
