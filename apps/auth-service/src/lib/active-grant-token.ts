import { getSql } from '../db/client.js';
import { getRedis } from '../redis/client.js';
import {
  verifyGrantToken,
  type VerifiedGrantTokenClaims,
} from './crypto.js';

export type ActiveGrantTokenCheckResult =
  | { ok: true; claims: VerifiedGrantTokenClaims }
  | {
      ok: false;
      reason:
        | 'invalid'
        | 'invalid_claims'
        | 'wrong_developer'
        | 'revoked'
        | 'expired'
        | 'not_found';
    };

export async function checkActiveGrantToken(
  token: string,
  options: { expectedDeveloperId?: string } = {},
): Promise<ActiveGrantTokenCheckResult> {
  let claims: VerifiedGrantTokenClaims;
  try {
    claims = await verifyGrantToken(token);
  } catch (err) {
    if (err instanceof Error && err.message === 'Missing required grant token claims') {
      return { ok: false, reason: 'invalid_claims' };
    }
    return { ok: false, reason: 'invalid' };
  }

  if (
    options.expectedDeveloperId !== undefined
    && claims.dev !== options.expectedDeveloperId
  ) {
    return { ok: false, reason: 'wrong_developer' };
  }

  const redis = getRedis();
  const [tokenRevoked, grantRevoked] = await Promise.all([
    redis.get(`revoked:tok:${claims.jti}`),
    redis.get(`revoked:grant:${claims.grnt}`),
  ]);

  if (tokenRevoked || grantRevoked) {
    return { ok: false, reason: 'revoked' };
  }

  const sql = getSql();
  const rows = await sql`
    SELECT gt.is_revoked, gt.expires_at, g.status AS grant_status
    FROM grant_tokens gt
    JOIN grants g ON g.id = gt.grant_id
    WHERE gt.jti = ${claims.jti}
      AND (${options.expectedDeveloperId ?? null}::text IS NULL OR g.developer_id = ${options.expectedDeveloperId ?? null})
  `;

  const row = rows[0];
  if (!row) {
    return { ok: false, reason: 'not_found' };
  }

  if ((row['is_revoked'] as boolean) || row['grant_status'] !== 'active') {
    return { ok: false, reason: 'revoked' };
  }

  if (new Date(row['expires_at'] as string) < new Date()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, claims };
}
