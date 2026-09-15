/**
 * Establishes who is approving a decision. The approver authenticates with
 * one of the developer's active OIDC SSO connections; the platform passes the
 * resulting ID token here. The token must verify against that connection
 * (signature by the provider's JWKS, issuer, audience = client id, expiry)
 * before any of its claims are read.
 */
import type { Sql } from './store.js';
import type { SsoConnectionRow } from '../sso.js';
import { verifyIdToken } from '../sso.js';

export class ApproverIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApproverIdentityError';
  }
}

export interface VerifiedApproverToken {
  connectionId: string;
  issuer: string;
  payload: Record<string, unknown>;
}

export async function verifyApproverIdToken(
  sql: Sql,
  developerId: string,
  connectionId: string,
  idToken: string,
): Promise<VerifiedApproverToken> {
  const rows = await sql<Pick<SsoConnectionRow, 'id' | 'issuer_url' | 'client_id'>[]>`
    SELECT id, issuer_url, client_id FROM sso_connections
    WHERE id = ${connectionId} AND developer_id = ${developerId}
      AND protocol = 'oidc' AND status = 'active'
  `;
  const connection = rows[0];
  if (!connection || !connection.issuer_url || !connection.client_id) {
    throw new ApproverIdentityError('No active OIDC SSO connection with this id');
  }
  let payload: Record<string, unknown>;
  try {
    payload = (await verifyIdToken(idToken, connection.issuer_url, connection.client_id)) as unknown as Record<string, unknown>;
  } catch {
    throw new ApproverIdentityError('ID token verification failed');
  }
  const issuer = payload['iss'];
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw new ApproverIdentityError('ID token has no issuer');
  }
  return { connectionId: connection.id, issuer, payload };
}
