import { generateKeyPair, exportJWK, importJWK, type KeyLike, type JWK } from 'jose';
import type postgres from 'postgres';
import { encrypt, decrypt } from '../vault-crypto.js';
import { newCommercePassportKid } from './ids.js';

type Sql = ReturnType<typeof postgres>;

export interface CommercePassportKey {
  kid: string;
  algorithm: 'ES256';
  status: 'active' | 'retired' | 'compromised';
  publicKeyJwk: Record<string, unknown>;
  createdAt: string;
  retiredAt: string | null;
}

export interface ActiveCommercePassportSigner {
  kid: string;
  algorithm: 'ES256';
  privateKey: KeyLike;
  publicKey: KeyLike;
}

interface CachedSigner {
  signer: ActiveCommercePassportSigner;
  fetchedAt: number;          // epoch ms
}

/**
 * Active signer cache TTL. A long-running instance must not keep signing
 * with a key that has been rotated out by another instance / ops action.
 * 60 s gives us low DB pressure (1 SELECT/min/instance) while bounding
 * the worst-case "still signing with stale key" window.
 */
const ACTIVE_SIGNER_TTL_MS = 60_000;

/**
 * JWKS retired-key grace window. Retired keys remain in JWKS and remain
 * verifiable for tokens issued BEFORE retired_at (verifier enforces the
 * iat cutoff separately). After this many seconds past retired_at, the
 * key is dropped from JWKS entirely. = max passport TTL (1h browse) +
 * 24h spec §6 safety margin.
 */
const RETIRED_KEY_GRACE_SECONDS = 3600 + 86_400;

const ACTIVE_SIGNER_CACHE = new Map<string, CachedSigner>();
const ACTIVE_CACHE_KEY = '__active__';

function isAutoGenerateAllowed(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  return process.env['COMMERCE_AUTO_GENERATE_PASSPORT_KEY'] === 'true';
}

function rowToKey(row: {
  kid: string;
  algorithm: string;
  status: string;
  public_key_jwk: Record<string, unknown>;
  created_at: Date | string;
  retired_at: Date | string | null;
}): CommercePassportKey {
  return {
    kid: row.kid,
    algorithm: 'ES256',
    status: row.status as CommercePassportKey['status'],
    publicKeyJwk: row.public_key_jwk,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    retiredAt: row.retired_at == null
      ? null
      : (row.retired_at instanceof Date ? row.retired_at.toISOString() : String(row.retired_at)),
  };
}

/**
 * Look up the active key (if any) without triggering generation.
 */
export async function findActiveCommercePassportKey(sql: Sql): Promise<CommercePassportKey | null> {
  const rows = await sql<Array<{
    kid: string;
    algorithm: string;
    status: string;
    public_key_jwk: Record<string, unknown>;
    created_at: Date;
    retired_at: Date | null;
  }>>`
    SELECT kid, algorithm, status, public_key_jwk, created_at, retired_at
      FROM commerce_passport_keys
     WHERE status = 'active'
     LIMIT 1
  `;
  return rows[0] ? rowToKey(rows[0]) : null;
}

/**
 * Return keys eligible for inclusion in JWKS:
 *   - status='active' always
 *   - status='retired' only if NOW() - retired_at < RETIRED_KEY_GRACE_SECONDS.
 * After the grace window passes, the retired key is dropped from JWKS so
 * a leaked retired private key can no longer be matched to a published
 * public key. Verification additionally enforces an iat cutoff so a
 * leaked retired key cannot mint NEW valid passports.
 */
export async function listCommercePassportKeysForJwks(sql: Sql): Promise<CommercePassportKey[]> {
  const rows = await sql<Array<{
    kid: string;
    algorithm: string;
    status: string;
    public_key_jwk: Record<string, unknown>;
    created_at: Date;
    retired_at: Date | null;
  }>>`
    SELECT kid, algorithm, status, public_key_jwk, created_at, retired_at
      FROM commerce_passport_keys
     WHERE status = 'active'
        OR (status = 'retired'
            AND retired_at IS NOT NULL
            AND retired_at > NOW() - (${RETIRED_KEY_GRACE_SECONDS} || ' seconds')::interval)
     ORDER BY created_at DESC
  `;
  return rows.map(rowToKey);
}

/**
 * Resolve the public key JWK + retired_at for a given kid. The verifier
 * uses retired_at to reject tokens with `iat > retired_at` for retired
 * keys (a stolen retired private key must not be able to mint NEW
 * valid passports). Returns null for unknown or compromised kids.
 */
export async function findPublicKeyByKid(
  sql: Sql,
  kid: string,
): Promise<{ publicKeyJwk: Record<string, unknown>; retiredAt: Date | null } | null> {
  const rows = await sql<Array<{
    public_key_jwk: Record<string, unknown>;
    retired_at: Date | null;
  }>>`
    SELECT public_key_jwk, retired_at
      FROM commerce_passport_keys
     WHERE kid = ${kid}
       AND status IN ('active','retired')
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { publicKeyJwk: row.public_key_jwk, retiredAt: row.retired_at };
}

/** @deprecated kept for back-compat tests; new code uses findPublicKeyByKid. */
export async function findPublicKeyJwkByKid(
  sql: Sql,
  kid: string,
): Promise<Record<string, unknown> | null> {
  const r = await findPublicKeyByKid(sql, kid);
  return r?.publicKeyJwk ?? null;
}

/**
 * Insert a brand-new ES256 keypair with status='active'. Atomic with the
 * partial-unique constraint uq_commerce_passport_keys_active so a
 * concurrent caller can't create two active keys.
 */
async function insertNewActiveKey(sql: Sql): Promise<ActiveCommercePassportSigner> {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = newCommercePassportKid();
  const encryptedPrivate = encrypt(JSON.stringify({ ...privateJwk, kid, alg: 'ES256' }));
  const publicJwkWithKid = { ...publicJwk, kid, alg: 'ES256', use: 'sig' };

  await sql`
    INSERT INTO commerce_passport_keys (
      kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status
    ) VALUES (
      ${kid}, 'ES256', ${JSON.stringify(publicJwkWithKid)}::jsonb,
      ${encryptedPrivate}, 'active'
    )
  `;

  return { kid, algorithm: 'ES256', privateKey, publicKey };
}

/**
 * Get the currently-active signing keypair.
 *
 *  - If an active row exists, decrypt and return it.
 *  - Process-local cache has a TTL (ACTIVE_SIGNER_TTL_MS) so a long-running
 *    instance picks up rotation done by another instance / ops action
 *    instead of signing forever with a key that's been rotated out.
 *  - If no active key exists AND COMMERCE_AUTO_GENERATE_PASSPORT_KEY=true
 *    AND NODE_ENV != production, generate one.
 *  - In production with no active key → throw. Operators must provision
 *    explicitly via the M2 admin runbook.
 *
 * The cache also re-validates on each call that the cached kid is still
 * the active one in the DB; if the active kid changed, the cache is
 * busted regardless of TTL. This handles the "rotation just happened"
 * window.
 */
export async function getActiveCommercePassportSigner(
  sql: Sql,
): Promise<ActiveCommercePassportSigner> {
  const cached = ACTIVE_SIGNER_CACHE.get(ACTIVE_CACHE_KEY);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < ACTIVE_SIGNER_TTL_MS) {
    // Within TTL, but verify it's still the active kid before serving.
    // One small SELECT to defend against rotation-mid-flight.
    const stillActive = await sql<Array<{ kid: string }>>`
      SELECT kid FROM commerce_passport_keys
       WHERE status = 'active' LIMIT 1
    `;
    if (stillActive[0]?.kid === cached.signer.kid) {
      return cached.signer;
    }
    // Active kid changed — busted cache. Fall through to refetch.
  }

  const active = await findActiveCommercePassportKey(sql);
  if (active) {
    const decryptedRows = await sql<Array<{ encrypted_private_key_jwk: string }>>`
      SELECT encrypted_private_key_jwk
        FROM commerce_passport_keys
       WHERE kid = ${active.kid}
       LIMIT 1
    `;
    const encryptedPrivate = decryptedRows[0]?.encrypted_private_key_jwk;
    if (!encryptedPrivate) {
      throw new Error(`active commerce passport key ${active.kid} missing encrypted material`);
    }
    const privateJwk = JSON.parse(decrypt(encryptedPrivate)) as Record<string, unknown>;
    const privateKey = await importJWK(privateJwk as unknown as JWK, 'ES256') as KeyLike;
    const publicKey = await importJWK(active.publicKeyJwk as unknown as JWK, 'ES256') as KeyLike;
    const signer: ActiveCommercePassportSigner = {
      kid: active.kid,
      algorithm: 'ES256',
      privateKey,
      publicKey,
    };
    ACTIVE_SIGNER_CACHE.set(ACTIVE_CACHE_KEY, { signer, fetchedAt: now });
    return signer;
  }

  if (!isAutoGenerateAllowed()) {
    throw new Error(
      'No active commerce passport key. Production must provision a key '
      + 'explicitly via the M2 admin runbook. Set '
      + 'COMMERCE_AUTO_GENERATE_PASSPORT_KEY=true (and NODE_ENV != production) '
      + 'to enable dev/test auto-generation.',
    );
  }

  const generated = await insertNewActiveKey(sql);
  ACTIVE_SIGNER_CACHE.set(ACTIVE_CACHE_KEY, { signer: generated, fetchedAt: now });
  return generated;
}

/**
 * Test-only — clear the in-process key cache so a test can simulate
 * service restart or rotation. NOT exported via index — direct named
 * import only.
 */
export function _resetCommercePassportKeyCacheForTests(): void {
  ACTIVE_SIGNER_CACHE.clear();
}

export const _internal = {
  ACTIVE_SIGNER_TTL_MS,
  RETIRED_KEY_GRACE_SECONDS,
};
