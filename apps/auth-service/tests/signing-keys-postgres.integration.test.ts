import postgres from 'postgres';
import { SignJWT, exportPKCS8, generateKeyPair, jwtVerify, type CryptoKey } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from './helpers/database.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  loadEnvKeys,
  loadPostgresSigningKeyRing,
  reloadPostgresSigningKeyRing,
  resolvePlatformVerificationKey,
  rotatePostgresSigningKey,
  setSigningKeyRing,
  SIGNING_ALGORITHMS,
  type PostgresKeyRingOptions,
  type SigningKeyRing,
} from '../src/lib/signing-keys.js';

// A database of its own; see FINDINGS G-24.
const adminDatabaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
let databaseUrl = adminDatabaseUrl;
let dropTestDatabase: (() => Promise<void>) | undefined;
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres signing key integration tests',
  );
}
const describePostgres = adminDatabaseUrl ? describe : describe.skip;
const OPTIONS: PostgresKeyRingOptions = { alg: 'RS256', retiredGraceSeconds: 86_400, legacyRetentionSeconds: 13 * 31 * 86_400 };
const algorithms = [...SIGNING_ALGORITHMS];

async function sign(ring: SigningKeyRing, kid: string = ring.active.kid): Promise<string> {
  return new SignJWT({ scp: ['read'] })
    .setProtectedHeader({ alg: ring.active.alg, kid })
    .setIssuedAt().setExpirationTime('1h')
    .sign(ring.active.privateKey);
}

async function verifies(sql: ReturnType<typeof postgres>, token: string): Promise<boolean> {
  setSigningKeyRing(await reloadPostgresSigningKeyRing(sql, OPTIONS));
  return jwtVerify(token, resolvePlatformVerificationKey, { algorithms }).then(() => true, () => false);
}

function connect(): ReturnType<typeof postgres> {
  return postgres(databaseUrl!, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
}

beforeAll(async () => {
  if (!adminDatabaseUrl) return;
  const db = await createTestDatabase('signing_keys');
  databaseUrl = db.url;
  dropTestDatabase = db.drop;
}, 60_000);

afterAll(async () => {
  await dropTestDatabase?.();
}, 60_000);

describePostgres('platform signing keys against real Postgres', () => {
  it('bridges from the env store without changing the signing kid or losing legacy tokens', async () => {
    const sql = connect();
    try {
      await runMigrations(sql);
      await sql`DELETE FROM platform_signing_keys`;
      const rsa = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
      const ec = await generateKeyPair('ES256', { extractable: true });
      const envKeys = await loadEnvKeys({
        alg: 'RS256', rsaPrivateKey: await exportPKCS8(rsa.privateKey), ecPrivateKey: await exportPKCS8(ec.privateKey),
        autoGenerate: false, verificationPublicKeys: null, legacyKidKey: null,
      });
      const legacyToken = await new SignJWT({ scp: ['read'] })
        .setProtectedHeader({ alg: 'RS256', kid: 'grantex-2026-09' }).setIssuedAt().setExpirationTime('1h')
        .sign(rsa.privateKey as CryptoKey);

      // Several instances switch to the postgres store together.
      const rings = await Promise.all([1, 2, 3].map(() => loadPostgresSigningKeyRing(sql, OPTIONS, envKeys)));
      for (const ring of rings) {
        expect(ring.active.kid).toBe(envKeys.signing!.kid);
        expect(ring.legacyKey?.kid).toBe(envKeys.signing!.kid);
      }
      const rows = await sql<{ kid: string; status: string; legacy_kid_alias: boolean; encrypted_private_key_jwk: string | null }[]>`
        SELECT kid, status, legacy_kid_alias, encrypted_private_key_jwk FROM platform_signing_keys ORDER BY status`;
      expect(rows.map((row) => [row.kid, row.status, row.legacy_kid_alias])).toEqual([
        [envKeys.signing!.kid, 'active', true],
        [envKeys.others[0]!.kid, 'retired', false],
      ]);
      // Private keys are stored bound to their kid, never as a plain JWK.
      expect(rows[0]!.encrypted_private_key_jwk).toMatch(/^ctx1:/);
      expect(rows[1]!.encrypted_private_key_jwk).toBeNull();

      await expect(verifies(sql, legacyToken)).resolves.toBe(true);
      await expect(verifies(sql, await sign(rings[0]!))).resolves.toBe(true);

      // A later start with the same env keys imports nothing new.
      await loadPostgresSigningKeyRing(sql, OPTIONS, envKeys);
      expect((await sql`SELECT kid FROM platform_signing_keys`).length).toBe(2);

      // A ciphertext moved to another row does not decrypt.
      await sql`UPDATE platform_signing_keys SET kid = 'grantex-rs256-moved0000000000' WHERE kid = ${envKeys.signing!.kid}`;
      await expect(reloadPostgresSigningKeyRing(sql, OPTIONS)).rejects.toMatchObject({ code: 'invalid_key' });
    } finally {
      await sql`DELETE FROM platform_signing_keys`.catch(() => {});
      await sql.end();
    }
  });

  it('rotates publish-then-sign and keeps the retired key verifiable for the grace window', async () => {
    const sql = connect();
    try {
      await runMigrations(sql);
      await sql`DELETE FROM platform_signing_keys`;

      // A fresh store generates one key even when instances start together.
      const rings = await Promise.all([1, 2, 3].map(() => loadPostgresSigningKeyRing(sql, OPTIONS)));
      const firstKid = rings[0]!.active.kid;
      expect(new Set(rings.map((ring) => ring.active.kid))).toEqual(new Set([firstKid]));
      expect(firstKid).toMatch(/^grantex-rs256-/);
      const beforeRotation = await sign(rings[0]!);

      const rotation = await rotatePostgresSigningKey(sql, 'ES256', 900);
      expect(rotation).toMatchObject({ currentKid: firstKid, alg: 'ES256' });
      expect(Date.parse(rotation.activatesAt)).toBeGreaterThan(Date.now() + 800_000);
      await expect(rotatePostgresSigningKey(sql, 'ES256', 900)).rejects.toMatchObject({ code: 'rotation_pending' });

      // Published at once, but the previous key still signs.
      let ring = await reloadPostgresSigningKeyRing(sql, OPTIONS);
      expect(ring.active.kid).toBe(firstKid);
      expect(ring.get(rotation.kid)).toMatchObject({ status: 'pending', alg: 'ES256', privateKey: null });

      // Once due, a reload promotes it and retires the previous key.
      await sql`UPDATE platform_signing_keys SET activates_at = NOW() - INTERVAL '1 second' WHERE kid = ${rotation.kid}`;
      ring = await reloadPostgresSigningKeyRing(sql, OPTIONS);
      expect(ring.active).toMatchObject({ kid: rotation.kid, alg: 'ES256' });
      expect(ring.get(firstKid)).toMatchObject({ status: 'retired', privateKey: null });
      const retired = await sql<{ encrypted_private_key_jwk: string | null }[]>`
        SELECT encrypted_private_key_jwk FROM platform_signing_keys WHERE kid = ${firstKid}`;
      expect(retired[0]!.encrypted_private_key_jwk).toBeNull();

      await expect(verifies(sql, beforeRotation)).resolves.toBe(true);
      await expect(verifies(sql, await sign(ring))).resolves.toBe(true);

      // Past the grace window the retired key is gone.
      await sql`UPDATE platform_signing_keys SET retired_at = NOW() - make_interval(secs => ${OPTIONS.retiredGraceSeconds + 60}) WHERE kid = ${firstKid}`;
      await expect(verifies(sql, beforeRotation)).resolves.toBe(false);

      // The schema refuses a second active key and unsupported rows.
      await expect(sql`
        INSERT INTO platform_signing_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status)
        VALUES ('second-active', 'ES256', '{}'::jsonb, 'x', 'active')`).rejects.toThrow();
      await expect(sql`
        INSERT INTO platform_signing_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status, retired_at)
        VALUES ('bad-alg', 'HS256', '{}'::jsonb, NULL, 'retired', NOW())`).rejects.toThrow();
      await expect(sql`
        INSERT INTO platform_signing_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status, retired_at, legacy_kid_alias)
        VALUES ('legacy-ec', 'ES256', '{}'::jsonb, NULL, 'retired', NOW(), TRUE)`).rejects.toThrow();
    } finally {
      await sql`DELETE FROM platform_signing_keys`.catch(() => {});
      await sql.end();
    }
  });

  it('keeps the legacy kid key published past the grace window, for the legacy alias window', async () => {
    const sql = connect();
    try {
      await runMigrations(sql);
      await sql`DELETE FROM platform_signing_keys`;
      const rsa = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
      const envKeys = await loadEnvKeys({
        alg: 'RS256', rsaPrivateKey: await exportPKCS8(rsa.privateKey), ecPrivateKey: null,
        autoGenerate: false, verificationPublicKeys: null, legacyKidKey: null,
      });
      await loadPostgresSigningKeyRing(sql, OPTIONS, envKeys);
      const legacyToken = await new SignJWT({ scp: ['read'] })
        .setProtectedHeader({ alg: 'RS256', kid: 'grantex-2026-09' }).setIssuedAt().setExpirationTime('1h')
        .sign(rsa.privateKey as CryptoKey);

      await rotatePostgresSigningKey(sql, 'RS256', 90);
      await sql`UPDATE platform_signing_keys SET activates_at = NOW() - INTERVAL '1 second' WHERE status = 'pending'`;
      await reloadPostgresSigningKeyRing(sql, OPTIONS);
      await sql`UPDATE platform_signing_keys SET retired_at = NOW() - make_interval(secs => ${OPTIONS.retiredGraceSeconds + 60}) WHERE legacy_kid_alias`;
      await expect(verifies(sql, legacyToken)).resolves.toBe(true);

      await sql`UPDATE platform_signing_keys SET retired_at = NOW() - make_interval(secs => ${OPTIONS.legacyRetentionSeconds + 60}) WHERE legacy_kid_alias`;
      await expect(verifies(sql, legacyToken)).resolves.toBe(false);
    } finally {
      await sql`DELETE FROM platform_signing_keys`.catch(() => {});
      await sql.end();
    }
  });
});
