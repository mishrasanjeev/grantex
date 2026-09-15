import postgres from 'postgres';
import { SignJWT, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import {
  loadPostgresSigningKeyRing,
  reloadPostgresSigningKeyRing,
  resolvePlatformVerificationKey,
  rotatePostgresSigningKey,
  setSigningKeyRing,
  SIGNING_ALGORITHMS,
} from '../src/lib/signing-keys.js';

const databaseUrl = process.env['AUDIT_INTEGRATION_DATABASE_URL'];
const ci = process.env['CI']?.trim().toLowerCase();
if ((ci === 'true' || ci === '1') && !databaseUrl) {
  throw new Error(
    'AUDIT_INTEGRATION_DATABASE_URL must be set in CI; refusing to skip the real-Postgres signing key integration tests',
  );
}
const describePostgres = databaseUrl ? describe : describe.skip;
const GRACE_SECONDS = 86_400;

describePostgres('platform signing keys against real Postgres', () => {
  it('generates one key under concurrent starts, rotates to ES256 and keeps the retired key verifiable', async () => {
    const sql = postgres(databaseUrl!, { max: 4, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
    try {
      await runMigrations(sql);
      await sql`DELETE FROM platform_signing_keys`;

      // Several instances starting together store exactly one active key.
      const rings = await Promise.all([1, 2, 3].map(() =>
        loadPostgresSigningKeyRing(sql, { alg: 'RS256', retiredGraceSeconds: GRACE_SECONDS })));
      const firstKid = rings[0]!.active.kid;
      expect(rings.map((ring) => ring.active.kid)).toEqual([firstKid, firstKid, firstKid]);
      expect(rings[0]!.active.alg).toBe('RS256');
      expect(firstKid).toMatch(/^grantex-rs256-/);

      const stored = await sql<{ encrypted_private_key_jwk: string; public_key_jwk: Record<string, unknown> }[]>`
        SELECT encrypted_private_key_jwk, public_key_jwk FROM platform_signing_keys WHERE kid = ${firstKid}`;
      expect(stored[0]!.public_key_jwk).toMatchObject({ kid: firstKid, alg: 'RS256', use: 'sig', kty: 'RSA' });
      expect(stored[0]!.public_key_jwk['d']).toBeUndefined();
      // The private key is stored encrypted, not as a JWK.
      expect(stored[0]!.encrypted_private_key_jwk).not.toContain('"d"');

      // A restart with a different configured algorithm keeps signing with the stored key.
      const restarted = await loadPostgresSigningKeyRing(sql, { alg: 'ES256', retiredGraceSeconds: GRACE_SECONDS });
      expect(restarted.active.kid).toBe(firstKid);

      setSigningKeyRing(restarted, () => reloadPostgresSigningKeyRing(sql, GRACE_SECONDS));
      const beforeRotation = await new SignJWT({ scp: ['read'] })
        .setProtectedHeader({ alg: restarted.active.alg, kid: restarted.active.kid })
        .setIssuedAt().setExpirationTime('1h')
        .sign(restarted.active.privateKey);

      const rotation = await rotatePostgresSigningKey(sql, 'ES256');
      expect(rotation).toMatchObject({ retiredKid: firstKid, alg: 'ES256' });
      expect(rotation.kid).toMatch(/^grantex-es256-/);

      const retiredRow = await sql<{ status: string; encrypted_private_key_jwk: string | null; retired_at: Date | null }[]>`
        SELECT status, encrypted_private_key_jwk, retired_at FROM platform_signing_keys WHERE kid = ${firstKid}`;
      expect(retiredRow[0]).toMatchObject({ status: 'retired', encrypted_private_key_jwk: null });
      expect(retiredRow[0]!.retired_at).not.toBeNull();

      const reloaded = await reloadPostgresSigningKeyRing(sql, GRACE_SECONDS);
      expect(reloaded.active).toMatchObject({ kid: rotation.kid, alg: 'ES256' });
      expect(reloaded.get(firstKid)).toMatchObject({ alg: 'RS256', status: 'retired', privateKey: null });
      setSigningKeyRing(reloaded, () => reloadPostgresSigningKeyRing(sql, GRACE_SECONDS));

      const algorithms = [...SIGNING_ALGORITHMS];
      await expect(jwtVerify(beforeRotation, resolvePlatformVerificationKey, { algorithms })).resolves.toBeDefined();
      const afterRotation = await new SignJWT({ scp: ['read'] })
        .setProtectedHeader({ alg: 'ES256', kid: reloaded.active.kid })
        .setIssuedAt().setExpirationTime('1h')
        .sign(reloaded.active.privateKey);
      await expect(jwtVerify(afterRotation, resolvePlatformVerificationKey, { algorithms })).resolves.toBeDefined();

      // Past the grace window the retired key is no longer published or accepted.
      await sql`UPDATE platform_signing_keys SET retired_at = NOW() - make_interval(secs => ${GRACE_SECONDS + 60}) WHERE kid = ${firstKid}`;
      const pruned = await reloadPostgresSigningKeyRing(sql, GRACE_SECONDS);
      expect(pruned.get(firstKid)).toBeUndefined();
      setSigningKeyRing(pruned);
      await expect(jwtVerify(beforeRotation, resolvePlatformVerificationKey, { algorithms }))
        .rejects.toMatchObject({ code: 'unknown_kid' });

      // The schema refuses a second active key and an active key without private material.
      await expect(sql`
        INSERT INTO platform_signing_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status)
        VALUES ('second-active', 'ES256', '{}'::jsonb, 'x', 'active')`).rejects.toThrow();
      await expect(sql`
        INSERT INTO platform_signing_keys (kid, algorithm, public_key_jwk, encrypted_private_key_jwk, status, retired_at)
        VALUES ('bad-alg', 'HS256', '{}'::jsonb, NULL, 'retired', NOW())`).rejects.toThrow();
    } finally {
      await sql`DELETE FROM platform_signing_keys`.catch(() => {});
      await sql.end();
    }
  });
});
