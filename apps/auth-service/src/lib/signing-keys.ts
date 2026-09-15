/**
 * Platform signing keys: the key that signs grant tokens, OAuth access tokens
 * and the other platform JWTs, plus the keys that still verify them.
 *
 * Key ids are the RFC 7638 thumbprint of the key (`grantex-<alg>-<16 chars>`),
 * so every instance publishes the same `kid` for the same key regardless of
 * when it started.
 *
 * Tokens signed before 0.6 carry the RS256 `kid` `grantex-YYYY-MM` of the
 * month their issuing process started. They keep verifying:
 *
 * - The *legacy key* is the RSA key those tokens were signed with (by default
 *   `RSA_PRIVATE_KEY`, or the key named by `JWT_LEGACY_KID_KEY`). An RS256
 *   token whose `kid` matches `grantex-YYYY-MM`, or that has no `kid`, is
 *   verified with it.
 * - The JWK Set publishes the legacy key again under `grantex-YYYY-MM` for the
 *   current month and the `JWT_LEGACY_KID_MONTHS - 1` months before it, so SDK
 *   verifiers that select keys by `kid` find it.
 * - For `SIGNING_KEY_ACTIVATION_DELAY_SECONDS` after start, a process signs
 *   with the legacy key under its legacy `kid`, so verifiers holding a JWK Set
 *   fetched from a pre-0.6 instance keep accepting new tokens while the
 *   thumbprint `kid` propagates.
 *
 * Stores:
 *
 * - `env` (default): `RSA_PRIVATE_KEY` or `EC_PRIVATE_KEY` signs, selected by
 *   `JWT_SIGNING_ALG`, or a key is generated with `AUTO_GENERATE_KEYS=true`. A
 *   configured key for the other algorithm, and every key in
 *   `JWT_VERIFICATION_PUBLIC_KEYS`, is published for verification only.
 * - `postgres`: keys live in `platform_signing_keys`, private keys encrypted
 *   with `VAULT_ENCRYPTION_KEY` and bound to their `kid`. Keys configured in
 *   the environment are imported on start (the env signing key becomes the
 *   stored active key when none exists), so switching stores changes nothing
 *   for outstanding tokens. Rotation is publish-then-sign: the new key is
 *   stored as `pending`, published at once, and becomes the signing key after
 *   the activation delay. The previous key is then retired, its private key
 *   erased, and it stays published for `SIGNING_KEY_RETIRED_GRACE_SECONDS`.
 *
 * Verification is fail-closed: `alg` must be RS256 or ES256, and the key must
 * be published for exactly that algorithm.
 */
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  type CryptoKey as KeyLike,
  type JWK,
  type JWTHeaderParameters,
} from 'jose';
import type postgres from 'postgres';
import { decryptWithContext, encryptWithContext } from './vault-crypto.js';
import {
  isSigningAlgorithm,
  keyTypeForAlgorithm,
  SIGNING_ALGORITHMS,
  type SigningAlgorithm,
} from './signing-algorithms.js';

export { SIGNING_ALGORITHMS, isSigningAlgorithm, type SigningAlgorithm } from './signing-algorithms.js';

type Sql = ReturnType<typeof postgres>;

/** Why a key could not be loaded or a token's key could not be resolved. */
export type SigningKeyErrorCode =
  | 'no_signing_key'
  | 'invalid_key'
  | 'duplicate_kid'
  | 'unsupported_alg'
  | 'missing_kid'
  | 'unknown_kid'
  | 'alg_key_mismatch'
  | 'rotation_pending'
  | 'keys_not_initialized';

export class SigningKeyError extends Error {
  readonly code: SigningKeyErrorCode;

  constructor(code: SigningKeyErrorCode, message: string) {
    super(message);
    this.name = 'SigningKeyError';
    this.code = code;
  }
}

export type SigningKeyStatus = 'pending' | 'active' | 'retired';

export interface SigningKey {
  kid: string;
  alg: SigningAlgorithm;
  /** Public JWK as published: public members plus `kid`, `alg` and `use`. */
  publicJwk: JWK & { kid: string; alg: SigningAlgorithm; use: 'sig' };
  publicKey: KeyLike;
  /** Present only for the active key. */
  privateKey: KeyLike | null;
  status: SigningKeyStatus;
  /** Signed the pre-0.6 tokens whose kid is `grantex-YYYY-MM`. */
  legacyKidAlias: boolean;
}

export interface ActiveSigningKey extends SigningKey {
  privateKey: KeyLike;
  status: 'active';
}

const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const MIN_RSA_MODULUS_BITS = 2048;
const KID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** The pre-0.6 RS256 kid: `grantex-YYYY-MM`. */
export const LEGACY_KID_RE = /^grantex-\d{4}-(0[1-9]|1[0-2])$/;

/** A set of keys with one active signer and unique `kid`s. */
export class SigningKeyRing {
  readonly active: ActiveSigningKey;
  readonly legacyKey: SigningKey | undefined;
  readonly #byKid: Map<string, SigningKey>;

  constructor(active: ActiveSigningKey, others: readonly SigningKey[] = []) {
    this.#byKid = new Map([[active.kid, active]]);
    for (const key of others) {
      const existing = this.#byKid.get(key.kid);
      if (existing !== undefined) {
        // The same key listed twice (for example a key being rotated in that
        // is also configured for verification) is one key.
        if (!sameKeyMaterial(existing, key)) {
          throw new SigningKeyError('duplicate_kid', `Signing key id "${key.kid}" is used by more than one key`);
        }
        if (key.legacyKidAlias && !existing.legacyKidAlias) {
          this.#byKid.set(key.kid, { ...existing, legacyKidAlias: true });
        }
        continue;
      }
      this.#byKid.set(key.kid, key);
    }
    // A duplicate entry may have added the legacy marker to the active key.
    this.active = this.#byKid.get(active.kid) as ActiveSigningKey;
    const legacy = [...this.#byKid.values()].filter((key) => key.legacyKidAlias);
    if (legacy.length > 1) {
      throw new SigningKeyError('invalid_key', 'More than one key is marked as the legacy kid key');
    }
    if (legacy[0] !== undefined && legacy[0].alg !== 'RS256') {
      throw new SigningKeyError('invalid_key', 'The legacy kid key must be an RS256 key');
    }
    this.legacyKey = legacy[0];
  }

  get(kid: string): SigningKey | undefined {
    return this.#byKid.get(kid);
  }

  /** Active key first, then the other keys in load order. */
  keys(): SigningKey[] {
    return [...this.#byKid.values()];
  }
}

function sameKeyMaterial(a: SigningKey, b: SigningKey): boolean {
  return a.alg === b.alg
    && JSON.stringify(publicMembers(a.publicJwk, a.alg)) === JSON.stringify(publicMembers(b.publicJwk, b.alg));
}

// ─── Key material helpers ────────────────────────────────────────────────────

function base64UrlByteLength(value: string): number {
  return Buffer.from(value, 'base64url').length;
}

/**
 * Throw unless `jwk` is a public key usable with `alg`: the right key type
 * (and curve), no private members, `use` absent or `sig`, `alg` absent or
 * equal to `alg`, and an RSA modulus of at least 2048 bits.
 */
export function assertPublicJwkForAlgorithm(jwk: Record<string, unknown>, alg: SigningAlgorithm): void {
  for (const member of PRIVATE_JWK_MEMBERS) {
    if (member in jwk) {
      throw new SigningKeyError('invalid_key', 'A published signing key must not contain private key members');
    }
  }
  if (jwk['use'] !== undefined && jwk['use'] !== 'sig') {
    throw new SigningKeyError('invalid_key', 'A signing key must have use "sig"');
  }
  if (jwk['alg'] !== undefined && jwk['alg'] !== alg) {
    throw new SigningKeyError('alg_key_mismatch', `Key is published for ${String(jwk['alg'])}, not ${alg}`);
  }
  const expected = keyTypeForAlgorithm(alg);
  if (jwk['kty'] !== expected.kty) {
    throw new SigningKeyError('alg_key_mismatch', `${alg} requires a ${expected.kty} key, got ${String(jwk['kty'])}`);
  }
  if (expected.kty === 'RSA') {
    if (typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') {
      throw new SigningKeyError('invalid_key', 'RSA key is missing n or e');
    }
    if (base64UrlByteLength(jwk['n']) * 8 < MIN_RSA_MODULUS_BITS) {
      throw new SigningKeyError('invalid_key', `RSA modulus must be at least ${MIN_RSA_MODULUS_BITS} bits`);
    }
  } else {
    if (jwk['crv'] !== 'P-256') {
      throw new SigningKeyError('alg_key_mismatch', `ES256 requires curve P-256, got ${String(jwk['crv'])}`);
    }
    if (typeof jwk['x'] !== 'string' || typeof jwk['y'] !== 'string') {
      throw new SigningKeyError('invalid_key', 'EC key is missing x or y');
    }
  }
}

function publicMembers(jwk: JWK, alg: SigningAlgorithm): JWK {
  const names = alg === 'RS256' ? ['kty', 'n', 'e'] as const : ['kty', 'crv', 'x', 'y'] as const;
  const result: Record<string, string> = {};
  for (const name of names) {
    const value = jwk[name];
    if (typeof value === 'string') result[name] = value;
  }
  return result as JWK;
}

function assertKid(kid: string): void {
  if (!KID_RE.test(kid)) {
    throw new SigningKeyError('invalid_key', 'A key id must be 1-128 characters of A-Z a-z 0-9 . _ : -');
  }
}

/** `grantex-<alg>-<first 16 chars of the RFC 7638 thumbprint>`. */
export async function thumbprintKid(alg: SigningAlgorithm, publicJwk: JWK): Promise<string> {
  const thumbprint = await calculateJwkThumbprint(publicMembers(publicJwk, alg), 'sha256');
  return `grantex-${alg.toLowerCase()}-${thumbprint.slice(0, 16)}`;
}

/** The pre-0.6 RS256 kid for a date: `grantex-YYYY-MM`. */
export function legacyRsaKid(now: Date = new Date()): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `grantex-${now.getUTCFullYear()}-${month}`;
}

/** Legacy kids for `now`'s month and the `months - 1` months before it, newest first. */
export function legacyKidsForWindow(now: Date, months: number): string[] {
  const kids: string[] = [];
  for (let i = 0; i < months; i += 1) {
    kids.push(legacyRsaKid(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  }
  return kids;
}

async function buildSigningKey(
  alg: SigningAlgorithm,
  kid: string,
  publicJwk: JWK,
  privateKey: KeyLike | null,
  status: SigningKeyStatus,
  legacyKidAlias = false,
): Promise<SigningKey> {
  assertKid(kid);
  const members = publicMembers(publicJwk, alg);
  assertPublicJwkForAlgorithm(members as Record<string, unknown>, alg);
  const publicKey = await importJWK(members, alg) as KeyLike;
  return {
    kid,
    alg,
    publicJwk: { ...members, kid, alg, use: 'sig' },
    publicKey,
    privateKey,
    status,
    legacyKidAlias,
  };
}

function asActive(key: SigningKey): ActiveSigningKey {
  if (key.privateKey === null) throw new SigningKeyError('no_signing_key', 'The active signing key has no private key');
  return { ...key, privateKey: key.privateKey, status: 'active' };
}

/** Import a PKCS#8 PEM private key for `alg` and derive its public key. */
export async function importPrivateKeyPem(
  pem: string,
  alg: SigningAlgorithm,
  settingName: string,
): Promise<{ privateKey: KeyLike; publicJwk: JWK }> {
  let privateKey: KeyLike;
  try {
    privateKey = await importPKCS8(pem.replace(/\\n/g, '\n'), alg, { extractable: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const expected = alg === 'RS256' ? 'an RSA' : 'an EC P-256';
    throw new SigningKeyError('invalid_key', `${settingName} must be ${expected} private key in PKCS#8 PEM form (${detail})`);
  }
  const jwk = await exportJWK(privateKey);
  const publicJwk = publicMembers(jwk, alg);
  assertPublicJwkForAlgorithm(publicJwk as Record<string, unknown>, alg);
  return { privateKey, publicJwk };
}

export async function generateSigningKeyMaterial(alg: SigningAlgorithm): Promise<{ privateKey: KeyLike; publicJwk: JWK }> {
  const { privateKey, publicKey } = alg === 'RS256'
    ? await generateKeyPair('RS256', { modulusLength: MIN_RSA_MODULUS_BITS, extractable: true })
    : await generateKeyPair('ES256', { extractable: true });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

/**
 * Parse `JWT_VERIFICATION_PUBLIC_KEYS`: a JWK Set of public keys, each with
 * `kid` and `alg` (RS256 or ES256), published for verification only.
 */
export async function parseVerificationPublicKeys(value: string | null): Promise<SigningKey[]> {
  const setting = 'JWT_VERIFICATION_PUBLIC_KEYS';
  if (value === null || value.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SigningKeyError('invalid_key', `${setting} must be a JSON Web Key Set`);
  }
  const keys = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)['keys']
    : undefined;
  if (!Array.isArray(keys)) {
    throw new SigningKeyError('invalid_key', `${setting} must be a JSON Web Key Set with a keys array`);
  }
  const result: SigningKey[] = [];
  for (const [index, raw] of keys.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SigningKeyError('invalid_key', `${setting} keys[${index}] must be an object`);
    }
    const jwk = raw as Record<string, unknown>;
    const alg = jwk['alg'];
    const kid = jwk['kid'];
    if (!isSigningAlgorithm(alg)) {
      throw new SigningKeyError('unsupported_alg', `${setting} keys[${index}].alg must be one of ${SIGNING_ALGORITHMS.join(', ')}`);
    }
    if (typeof kid !== 'string') {
      throw new SigningKeyError('invalid_key', `${setting} keys[${index}].kid must be a string`);
    }
    if (LEGACY_KID_RE.test(kid)) {
      throw new SigningKeyError('invalid_key', `${setting} keys[${index}].kid must not be a legacy grantex-YYYY-MM kid; use the key's thumbprint kid and JWT_LEGACY_KID_KEY`);
    }
    assertPublicJwkForAlgorithm(jwk, alg);
    result.push(await buildSigningKey(alg, kid, jwk as JWK, null, 'retired'));
  }
  return result;
}

// ─── env store ───────────────────────────────────────────────────────────────

export interface EnvKeyRingOptions {
  alg: SigningAlgorithm;
  rsaPrivateKey: string | null;
  ecPrivateKey: string | null;
  autoGenerate: boolean;
  verificationPublicKeys: string | null;
  /** kid of the key that signed `grantex-YYYY-MM` tokens; default: the RSA key. */
  legacyKidKey: string | null;
}

/**
 * The keys configured in the environment. `signing` is the key for `alg`
 * (configured or, with `autoGenerate`, generated); it is null when neither.
 */
export async function loadEnvKeys(options: EnvKeyRingOptions): Promise<{ signing: ActiveSigningKey | null; others: SigningKey[] }> {
  const pems: Record<SigningAlgorithm, { pem: string | null; setting: string }> = {
    RS256: { pem: options.rsaPrivateKey, setting: 'RSA_PRIVATE_KEY' },
    ES256: { pem: options.ecPrivateKey, setting: 'EC_PRIVATE_KEY' },
  };

  let signing: ActiveSigningKey | null = null;
  const configured = pems[options.alg];
  const material = configured.pem
    ? await importPrivateKeyPem(configured.pem, options.alg, configured.setting)
    : options.autoGenerate ? await generateSigningKeyMaterial(options.alg) : null;
  if (material !== null) {
    const kid = await thumbprintKid(options.alg, material.publicJwk);
    signing = asActive(await buildSigningKey(options.alg, kid, material.publicJwk, material.privateKey, 'active'));
  }

  // The RSA key from the environment (RSA_PRIVATE_KEY, or a generated RS256
  // signing key) is the default legacy kid key.
  let rsaKid: string | null = signing?.alg === 'RS256' ? signing.kid : null;
  const others: SigningKey[] = [];
  for (const alg of SIGNING_ALGORITHMS) {
    if (alg === options.alg) continue;
    const other = pems[alg];
    if (!other.pem) continue;
    const imported = await importPrivateKeyPem(other.pem, alg, other.setting);
    // Published for verification only: the private key is not kept.
    const key = await buildSigningKey(alg, await thumbprintKid(alg, imported.publicJwk), imported.publicJwk, null, 'retired');
    if (alg === 'RS256') rsaKid = key.kid;
    others.push(key);
  }
  others.push(...await parseVerificationPublicKeys(options.verificationPublicKeys));

  const legacyKid = options.legacyKidKey ?? rsaKid;
  if (legacyKid !== null) {
    const all = [...(signing ? [signing] : []), ...others];
    const legacy = all.find((key) => key.kid === legacyKid);
    if (legacy === undefined) {
      throw new SigningKeyError('invalid_key', `JWT_LEGACY_KID_KEY ${legacyKid} names no configured key`);
    }
    if (legacy.alg !== 'RS256') throw new SigningKeyError('invalid_key', 'JWT_LEGACY_KID_KEY must name an RS256 key');
    if (signing && signing.kid === legacyKid) signing = { ...signing, legacyKidAlias: true };
    for (const [index, key] of others.entries()) {
      if (key.kid === legacyKid) others[index] = { ...key, legacyKidAlias: true };
    }
  }
  return { signing, others };
}

export async function loadEnvSigningKeyRing(options: EnvKeyRingOptions): Promise<SigningKeyRing> {
  const { signing, others } = await loadEnvKeys(options);
  if (signing === null) {
    const what = options.alg === 'RS256' ? 'No RSA key configured' : 'No EC P-256 key configured';
    const setting = options.alg === 'RS256' ? 'RSA_PRIVATE_KEY' : 'EC_PRIVATE_KEY';
    throw new SigningKeyError(
      'no_signing_key',
      `${what} for JWT_SIGNING_ALG=${options.alg}: set ${setting} or AUTO_GENERATE_KEYS=true`,
    );
  }
  return new SigningKeyRing(signing, others);
}

// ─── postgres store ──────────────────────────────────────────────────────────

interface KeyRow {
  kid: string;
  algorithm: string;
  public_key_jwk: Record<string, unknown>;
  encrypted_private_key_jwk: string | null;
  status: string;
  legacy_kid_alias: boolean;
}

const KEY_TABLE_LOCK = 'grantex:platform_signing_keys';

/** Additional authenticated data binding a stored private key to its row. */
export function privateKeyContext(kid: string): string {
  return `grantex:platform_signing_keys:${kid}`;
}

async function rowToKey(row: KeyRow): Promise<SigningKey> {
  if (!isSigningAlgorithm(row.algorithm)) {
    throw new SigningKeyError('unsupported_alg', `Stored signing key ${row.kid} has unsupported algorithm ${row.algorithm}`);
  }
  const alg = row.algorithm;
  const status = row.status as SigningKeyStatus;
  if (status === 'active') {
    if (row.encrypted_private_key_jwk === null) {
      throw new SigningKeyError('no_signing_key', `Active signing key ${row.kid} has no private key`);
    }
    let privateJwk: JWK;
    try {
      privateJwk = JSON.parse(decryptWithContext(row.encrypted_private_key_jwk, privateKeyContext(row.kid))) as JWK;
    } catch {
      throw new SigningKeyError('invalid_key', `Stored signing key ${row.kid} cannot be decrypted for its kid`);
    }
    const privateKey = await importJWK(privateJwk, alg) as KeyLike;
    const derived = publicMembers(privateJwk, alg);
    const stored = publicMembers(row.public_key_jwk as JWK, alg);
    if (JSON.stringify(derived) !== JSON.stringify(stored)) {
      throw new SigningKeyError('invalid_key', `Stored signing key ${row.kid} does not match its private key`);
    }
    return buildSigningKey(alg, row.kid, stored, privateKey, 'active', row.legacy_kid_alias);
  }
  return buildSigningKey(alg, row.kid, row.public_key_jwk as JWK, null, status, row.legacy_kid_alias);
}

async function insertKey(
  tx: Sql,
  key: { kid: string; alg: SigningAlgorithm; publicJwk: JWK; privateKey: KeyLike | null; legacyKidAlias: boolean },
  status: SigningKeyStatus,
  activationDelaySeconds = 0,
): Promise<void> {
  const publicJwk = { ...publicMembers(key.publicJwk, key.alg), kid: key.kid, alg: key.alg, use: 'sig' };
  const encrypted = key.privateKey === null
    ? null
    : encryptWithContext(JSON.stringify(await exportJWK(key.privateKey)), privateKeyContext(key.kid));
  await tx`
    INSERT INTO platform_signing_keys (
      kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status,
      activates_at, retired_at, legacy_kid_alias
    ) VALUES (
      ${key.kid}, ${key.alg}, ${tx.json(publicJwk as never)}, ${encrypted}, ${status},
      ${status === 'pending' ? tx`NOW() + make_interval(secs => ${activationDelaySeconds})` : null},
      ${status === 'retired' ? tx`NOW()` : null},
      ${key.legacyKidAlias}
    )
  `;
}

async function generateKey(alg: SigningAlgorithm): Promise<{ kid: string; alg: SigningAlgorithm; publicJwk: JWK; privateKey: KeyLike; legacyKidAlias: false }> {
  const material = await generateSigningKeyMaterial(alg);
  return { kid: await thumbprintKid(alg, material.publicJwk), alg, ...material, legacyKidAlias: false };
}

/**
 * Promote a pending key whose activation time has passed: retire the active
 * key (erasing its private key) and make the pending key active. Returns the
 * promoted kid, or null when nothing was due.
 */
export async function promoteDuePendingKey(sql: Sql): Promise<string | null> {
  let promoted: string | null = null;
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`SELECT pg_advisory_xact_lock(hashtextextended(${KEY_TABLE_LOCK}, 0))`;
    const due = await t<{ kid: string }[]>`
      SELECT kid FROM platform_signing_keys WHERE status = 'pending' AND activates_at <= NOW()
    `;
    if (!due[0]) return;
    await t`
      UPDATE platform_signing_keys
         SET status = 'retired', retired_at = NOW(), encrypted_private_key_jwk = NULL
       WHERE status = 'active'
    `;
    await t`
      UPDATE platform_signing_keys SET status = 'active', activates_at = NULL WHERE kid = ${due[0].kid}
    `;
    promoted = due[0].kid;
  });
  return promoted;
}

export interface PostgresKeyRingOptions {
  /** Algorithm for the first key when none is stored. */
  alg: SigningAlgorithm;
  retiredGraceSeconds: number;
  /** How long the legacy kid key stays published after retirement. */
  legacyRetentionSeconds: number;
}

async function selectRing(sql: Sql, options: PostgresKeyRingOptions): Promise<SigningKeyRing | null> {
  await promoteDuePendingKey(sql);
  const rows = await sql<KeyRow[]>`
    SELECT kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status, legacy_kid_alias
      FROM platform_signing_keys
     WHERE status IN ('active', 'pending')
        OR (status = 'retired' AND retired_at > NOW() - make_interval(secs => ${options.retiredGraceSeconds}))
        OR (status = 'retired' AND legacy_kid_alias AND retired_at > NOW() - make_interval(secs => ${options.legacyRetentionSeconds}))
     ORDER BY (status = 'active') DESC, created_at DESC
  `;
  const activeRows = rows.filter((row) => row.status === 'active');
  if (activeRows.length === 0) return null;
  if (activeRows.length > 1) {
    throw new SigningKeyError('duplicate_kid', 'More than one active platform signing key is stored');
  }
  const [active, ...rest] = await Promise.all(rows.map(rowToKey));
  return new SigningKeyRing(asActive(active!), rest);
}

/**
 * Load the stored key set.
 *
 * Keys still configured in the environment (`envKeys`) are imported first,
 * once: the env signing key becomes the active key when none is stored, and
 * every other env key is stored as retired (public only), keeping the legacy
 * kid marker. A key is generated only when there is still no active key. The
 * stored active key signs even when its algorithm differs from `alg`; changing
 * algorithm is a rotation.
 */
export async function loadPostgresSigningKeyRing(
  sql: Sql,
  options: PostgresKeyRingOptions,
  envKeys: { signing: ActiveSigningKey | null; others: SigningKey[] } = { signing: null, others: [] },
): Promise<SigningKeyRing> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`SELECT pg_advisory_xact_lock(hashtextextended(${KEY_TABLE_LOCK}, 0))`;
    const stored = await t<{ kid: string; status: string; legacy_kid_alias: boolean }[]>`
      SELECT kid, status, legacy_kid_alias FROM platform_signing_keys
    `;
    const kids = new Set(stored.map((row) => row.kid));
    let hasActive = stored.some((row) => row.status === 'active');
    let hasLegacy = stored.some((row) => row.legacy_kid_alias);
    const candidates = [...(envKeys.signing ? [envKeys.signing] : []), ...envKeys.others];
    for (const key of candidates) {
      if (kids.has(key.kid)) continue;
      const legacyKidAlias = key.legacyKidAlias && !hasLegacy;
      if (key === envKeys.signing && !hasActive) {
        await insertKey(t, { ...key, legacyKidAlias }, 'active');
        hasActive = true;
      } else {
        await insertKey(t, { ...key, privateKey: null, legacyKidAlias }, 'retired');
      }
      hasLegacy ||= legacyKidAlias;
      kids.add(key.kid);
    }
    if (!hasActive) await insertKey(t, await generateKey(options.alg), 'active');
  });
  const ring = await selectRing(sql, options);
  if (!ring) throw new SigningKeyError('no_signing_key', 'No active platform signing key after loading');
  return ring;
}

/** Reload the stored key set (promoting a due pending key) without importing or generating. */
export async function reloadPostgresSigningKeyRing(sql: Sql, options: PostgresKeyRingOptions): Promise<SigningKeyRing> {
  const ring = await selectRing(sql, options);
  if (!ring) throw new SigningKeyError('no_signing_key', 'No active platform signing key is stored');
  return ring;
}

/**
 * Start a publish-then-sign rotation: store a new key for `alg` as pending. It
 * is published at once and becomes the signing key `activationDelaySeconds`
 * later, when an instance's reload promotes it.
 */
export async function rotatePostgresSigningKey(
  sql: Sql,
  alg: SigningAlgorithm,
  activationDelaySeconds: number,
): Promise<{ currentKid: string | null; kid: string; alg: SigningAlgorithm; activatesAt: string }> {
  let currentKid: string | null = null;
  let kid = '';
  let activatesAt = '';
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    await t`SELECT pg_advisory_xact_lock(hashtextextended(${KEY_TABLE_LOCK}, 0))`;
    const pending = await t<{ kid: string }[]>`SELECT kid FROM platform_signing_keys WHERE status = 'pending'`;
    if (pending[0]) {
      throw new SigningKeyError('rotation_pending', `Key ${pending[0].kid} is already pending activation`);
    }
    const active = await t<{ kid: string }[]>`SELECT kid FROM platform_signing_keys WHERE status = 'active'`;
    currentKid = active[0]?.kid ?? null;
    const key = await generateKey(alg);
    await insertKey(t, key, 'pending', activationDelaySeconds);
    const row = await t<{ activates_at: Date }[]>`SELECT activates_at FROM platform_signing_keys WHERE kid = ${key.kid}`;
    kid = key.kid;
    activatesAt = new Date(row[0]!.activates_at).toISOString();
  });
  return { currentKid, kid, alg, activatesAt };
}

// ─── Process key set and verification ────────────────────────────────────────

let currentRing: SigningKeyRing | null = null;
let reloader: (() => Promise<SigningKeyRing>) | null = null;
let lastUnknownKidReloadAt = 0;
export const UNKNOWN_KID_RELOAD_COOLDOWN_MS = 30_000;

interface LegacyKidPolicy {
  /** Months of `grantex-YYYY-MM` aliases published; 0 publishes none. */
  months: number;
  /** Until this time (ms), the legacy key signs under its legacy kid. */
  transitionUntilMs: number;
  startedAt: Date;
}

let legacyPolicy: LegacyKidPolicy = { months: 0, transitionUntilMs: 0, startedAt: new Date(0) };

export function setLegacyKidPolicy(policy: { months: number; transitionSeconds: number; startedAt?: Date }): void {
  const startedAt = policy.startedAt ?? new Date();
  legacyPolicy = {
    months: policy.months,
    transitionUntilMs: policy.months > 0 ? startedAt.getTime() + policy.transitionSeconds * 1000 : 0,
    startedAt,
  };
}

export function setSigningKeyRing(ring: SigningKeyRing, reload: (() => Promise<SigningKeyRing>) | null = null): void {
  currentRing = ring;
  reloader = reload;
  lastUnknownKidReloadAt = 0;
}

export function getSigningKeyRing(): SigningKeyRing {
  if (!currentRing) throw new SigningKeyError('keys_not_initialized', 'Keys not initialized — call initKeys() first');
  return currentRing;
}

/** The kid to put in the header of a token signed now with the active key. */
export function signingKid(now: number = Date.now()): string {
  const ring = getSigningKeyRing();
  if (ring.active.legacyKidAlias && now < legacyPolicy.transitionUntilMs) {
    return legacyRsaKid(legacyPolicy.startedAt);
  }
  return ring.active.kid;
}

/**
 * The JWK Set entries for the platform signing keys: every key, then the
 * legacy key again under each `grantex-YYYY-MM` kid of the alias window.
 */
export function publishedSigningJwks(now: Date = new Date()): Array<Record<string, unknown>> {
  const ring = getSigningKeyRing();
  const entries: Array<Record<string, unknown>> = ring.keys().map((key) => ({ ...key.publicJwk }));
  if (ring.legacyKey !== undefined) {
    for (const kid of legacyKidsForWindow(now, legacyPolicy.months)) {
      if (ring.get(kid) === undefined) entries.push({ ...ring.legacyKey.publicJwk, kid });
    }
  }
  return entries;
}

/**
 * Reload from the store now (postgres store only). Returns false when there is
 * no store to reload. Does not affect the unknown-kid cooldown.
 */
export async function reloadSigningKeyRing(): Promise<boolean> {
  if (!reloader) return false;
  currentRing = await reloader();
  return true;
}

/**
 * Resolve the platform key for a JWS protected header. Used as the key
 * argument of `jwtVerify` together with `algorithms: SIGNING_ALGORITHMS`.
 *
 * - `alg` must be RS256 or ES256.
 * - A `kid` naming a key selects it. Otherwise, an RS256 token whose `kid` is
 *   a legacy `grantex-YYYY-MM` kid, or that has no `kid`, uses the legacy key.
 *   A token without `kid` and without a legacy key uses the active key.
 * - An unknown `kid` triggers at most one store reload per cooldown.
 * - The key must be published for the token's `alg`.
 */
export async function resolvePlatformVerificationKey(header: JWTHeaderParameters): Promise<KeyLike> {
  const alg = header.alg;
  if (!isSigningAlgorithm(alg)) {
    throw new SigningKeyError('unsupported_alg', `Token algorithm ${String(alg)} is not allowed`);
  }
  const kid = header.kid;
  if (kid !== undefined && (typeof kid !== 'string' || kid.length === 0)) {
    throw new SigningKeyError('missing_kid', 'Token kid must be a non-empty string');
  }

  const lookup = (ring: SigningKeyRing): SigningKey | undefined => {
    if (kid !== undefined) {
      const named = ring.get(kid);
      if (named !== undefined) return named;
      return LEGACY_KID_RE.test(kid) && alg === 'RS256' ? ring.legacyKey : undefined;
    }
    if (alg === 'RS256' && ring.legacyKey !== undefined) return ring.legacyKey;
    return ring.active.alg === alg ? ring.active : undefined;
  };

  let key = lookup(getSigningKeyRing());
  if (key === undefined && kid === undefined) {
    throw new SigningKeyError('missing_kid', `Token has no kid and no ${alg} key can verify it`);
  }
  if (key === undefined && reloader && Date.now() - lastUnknownKidReloadAt >= UNKNOWN_KID_RELOAD_COOLDOWN_MS) {
    lastUnknownKidReloadAt = Date.now();
    await reloadSigningKeyRing();
    key = lookup(getSigningKeyRing());
  }
  if (key === undefined) {
    throw new SigningKeyError('unknown_kid', `No platform signing key has kid ${String(kid)}`);
  }
  if (key.alg !== alg) {
    throw new SigningKeyError('alg_key_mismatch', `Key ${key.kid} is published for ${key.alg}, not ${alg}`);
  }
  return key.publicKey;
}
