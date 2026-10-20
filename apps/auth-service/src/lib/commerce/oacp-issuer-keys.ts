// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * OACP issuer keys (migration 133, `oacp_issuer_keys`): the ES256 keys that
 * sign OACP artifacts, following the commerce passport key store
 * (passport-keys.ts).
 *
 * - One key is `active` and signs. `rotateOacpIssuerKey` creates a new active
 *   key and retires the previous one in one transaction.
 * - A `retired` key signs nothing new but stays in /.well-known/jwks.json
 *   until every artifact it signed has expired (plus a grace window for
 *   caches and clock skew), so artifacts issued before a rotation keep
 *   verifying for their whole life.
 * - A `revoked` key is withdrawn from the JWKS at once: every artifact it
 *   signed stops verifying (`issuer_key_untrusted`).
 * - Private JWKs are encrypted with the vault key and bound to their kid
 *   (vault-crypto.ts `encryptWithContext`), so a ciphertext copied onto
 *   another row does not decrypt.
 * - With no active key, issuance fails closed. Outside production,
 *   OACP_AUTO_GENERATE_ISSUER_KEY=true creates one on first use; in
 *   production an operator rotates (which creates the first key) through
 *   `POST /v1/commerce/oacp/issuer-keys/rotate`.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import type postgres from 'postgres';
import type { TxSql } from '../../db/client.js';
import { decryptWithContext, encryptWithContext } from '../vault-crypto.js';
import { newOacpIssuerKid } from './ids.js';
import type { OacpSigningKey } from './oacp-jws.js';

type Sql = ReturnType<typeof postgres>;

export type OacpIssuerKeyStatus = 'active' | 'retired' | 'revoked';

export interface OacpIssuerKey {
  kid: string;
  status: OacpIssuerKeyStatus;
  publicJwk: Record<string, unknown>;
  createdAt: string;
  retiredAt: string | null;
  revokedAt: string | null;
}

/**
 * How long a retired key stays published after its last artifact expired, and
 * at least after it was retired: covers JWKS caches (5 s here, minutes at a
 * relying party) and verifier clock skew.
 */
export const OACP_RETIRED_KEY_GRACE_SECONDS = 600;
/** A long-running instance re-reads the active key at least this often. */
const ACTIVE_SIGNER_TTL_MS = 60_000;
const ROTATION_LOCK = 'grantex:oacp-issuer-key-rotation';

let cachedSigner: { signer: OacpSigningKey; fetchedAt: number } | null = null;

function keyContext(kid: string): string {
  return `oacp-issuer-key:${kid}`;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToKey(row: Record<string, unknown>): OacpIssuerKey {
  return {
    kid: row['kid'] as string,
    status: row['status'] as OacpIssuerKeyStatus,
    publicJwk: row['public_key_jwk'] as Record<string, unknown>,
    createdAt: iso(row['created_at']) ?? '',
    retiredAt: iso(row['retired_at']),
    revokedAt: iso(row['revoked_at']),
  };
}

function autoGenerateAllowed(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  return process.env['OACP_AUTO_GENERATE_ISSUER_KEY'] === 'true';
}

/** A fresh ES256 key pair as an OACP signing key and its encrypted private JWK. */
function generateKey(now: Date): { signer: OacpSigningKey; encrypted: string } {
  const kid = newOacpIssuerKid(now);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const publicJwk = { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, kid, alg: 'ES256', use: 'sig' };
  const encrypted = encryptWithContext(JSON.stringify(priv), keyContext(kid));
  return { signer: { kid, privateKey, publicJwk }, encrypted };
}

async function insertActive(sql: TxSql, now: Date): Promise<OacpSigningKey> {
  const { signer, encrypted } = generateKey(now);
  await sql`
    INSERT INTO oacp_issuer_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status)
    VALUES (${signer.kid}, 'ES256', ${sql.json(signer.publicJwk as never)}, ${encrypted}, 'active')
  `;
  return signer;
}

function decryptSigner(kid: string, publicJwk: Record<string, unknown>, encrypted: string): OacpSigningKey {
  const jwk = JSON.parse(decryptWithContext(encrypted, keyContext(kid))) as Record<string, unknown>;
  return { kid, privateKey: createPrivateKey({ key: jwk as never, format: 'jwk' }), publicJwk };
}

/**
 * The key that signs new artifacts. Cached for at most a minute, and the
 * cached kid is re-checked against the database on every call so a rotation
 * by another instance takes effect at once.
 */
export async function getActiveOacpSigner(sql: Sql): Promise<OacpSigningKey> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT kid, public_key_jwk, encrypted_private_key_jwk
    FROM oacp_issuer_keys WHERE status = 'active' LIMIT 1
  `;
  const row = rows[0];
  if (row) {
    const kid = row['kid'] as string;
    if (cachedSigner && cachedSigner.signer.kid === kid && Date.now() - cachedSigner.fetchedAt < ACTIVE_SIGNER_TTL_MS) {
      return cachedSigner.signer;
    }
    const signer = decryptSigner(kid, row['public_key_jwk'] as Record<string, unknown>, row['encrypted_private_key_jwk'] as string);
    cachedSigner = { signer, fetchedAt: Date.now() };
    return signer;
  }
  if (!autoGenerateAllowed()) {
    throw new OacpIssuerKeyUnavailableError();
  }
  const created = await rotateOacpIssuerKey(sql, new Date(), { onlyIfNone: true });
  return created.signer;
}

export class OacpIssuerKeyUnavailableError extends Error {
  constructor() {
    super('No active OACP issuer key. An operator must create one with POST /v1/commerce/oacp/issuer-keys/rotate.');
    this.name = 'OacpIssuerKeyUnavailableError';
  }
}

/**
 * Create a new active key and retire the current one, in one transaction
 * serialised by an advisory lock. With no current key this creates the first.
 */
export async function rotateOacpIssuerKey(
  sql: Sql,
  now: Date = new Date(),
  options: { onlyIfNone?: boolean } = {},
): Promise<{ signer: OacpSigningKey; retiredKid: string | null }> {
  const result = await sql.begin(async (tx) => {
    const t = tx as unknown as TxSql;
    await t`SELECT pg_advisory_xact_lock(hashtextextended(${ROTATION_LOCK}, 0))`;
    if (options.onlyIfNone) {
      // First use outside production: another instance may have created the
      // key while this one waited for the lock.
      const [existing] = await t`
        SELECT kid, public_key_jwk, encrypted_private_key_jwk
        FROM oacp_issuer_keys WHERE status = 'active' LIMIT 1
      `;
      if (existing) {
        return {
          signer: decryptSigner(existing['kid'] as string, existing['public_key_jwk'] as Record<string, unknown>, existing['encrypted_private_key_jwk'] as string),
          retiredKid: null,
        };
      }
    }
    const retired = await t`
      UPDATE oacp_issuer_keys SET status = 'retired', retired_at = NOW()
      WHERE status = 'active'
      RETURNING kid
    `;
    const signer = await insertActive(t, now);
    return { signer, retiredKid: (retired[0]?.['kid'] as string | undefined) ?? null };
  });
  cachedSigner = { signer: result.signer, fetchedAt: Date.now() };
  return result;
}

/**
 * Withdraw a key: it leaves the JWKS on the next fetch and every artifact it
 * signed stops verifying. Revoking the active key leaves no active key until
 * the next rotation. Null for an unknown kid.
 */
export async function revokeOacpIssuerKey(sql: Sql, kid: string): Promise<OacpIssuerKey | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    UPDATE oacp_issuer_keys
    SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
    WHERE kid = ${kid}
    RETURNING kid, status, public_key_jwk, created_at, retired_at, revoked_at
  `;
  if (cachedSigner?.signer.kid === kid) cachedSigner = null;
  return rows[0] ? rowToKey(rows[0]) : null;
}

/** Every key, newest first, without private material. */
export async function listOacpIssuerKeys(sql: Sql): Promise<OacpIssuerKey[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT kid, status, public_key_jwk, created_at, retired_at, revoked_at
    FROM oacp_issuer_keys ORDER BY created_at DESC, kid DESC
  `;
  return rows.map(rowToKey);
}

/**
 * The public JWKs to publish: the active key, and each retired key while an
 * artifact or mandate (oacp_mandates) it signed is unexpired or it was retired recently (both within
 * the grace window). Revoked keys never.
 */
export async function listOacpIssuerJwksKeys(sql: Sql): Promise<Array<Record<string, unknown>>> {
  const rows = await sql<Array<{ public_key_jwk: Record<string, unknown> }>>`
    SELECT k.public_key_jwk
    FROM oacp_issuer_keys k
    WHERE k.status = 'active'
       OR (k.status = 'retired' AND (
            k.retired_at > NOW() - make_interval(secs => ${OACP_RETIRED_KEY_GRACE_SECONDS})
            OR EXISTS (
              SELECT 1 FROM oacp_artifacts a
              WHERE a.issuer_key_id = k.kid
                AND a.status <> 'refused'
                AND a.expires_at > NOW() - make_interval(secs => ${OACP_RETIRED_KEY_GRACE_SECONDS})
            )
            OR EXISTS (
              SELECT 1 FROM oacp_mandates m
              WHERE m.issuer_key_id = k.kid
                AND m.status <> 'refused'
                AND m.expires_at > NOW() - make_interval(secs => ${OACP_RETIRED_KEY_GRACE_SECONDS})
            )
          ))
    ORDER BY k.created_at DESC, k.kid DESC
  `;
  return rows.map((row) => row.public_key_jwk);
}

/** Forget the cached signer (tests, or after an out-of-band key change). */
export function resetOacpIssuerKeyCache(): void {
  cachedSigner = null;
}
