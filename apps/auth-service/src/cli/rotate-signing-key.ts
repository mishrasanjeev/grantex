/**
 * Rotate the stored platform signing key (SIGNING_KEY_STORE=postgres).
 *
 *   node dist/cli/rotate-signing-key.js [--alg RS256|ES256]
 *
 * Retires the active key, erasing its private key, and stores a new active
 * key for `--alg` (default JWT_SIGNING_ALG). The retired key stays in the JWK
 * Set for SIGNING_KEY_RETIRED_GRACE_SECONDS. Running instances pick up the new
 * key within a minute. Exits non-zero, printing the reason, on any failure.
 */
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { closeSql, getSql } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { parseSigningAlgorithm } from '../lib/signing-algorithms.js';
import { rotatePostgresSigningKey } from '../lib/signing-keys.js';

export function parseRotateArgs(argv: readonly string[], defaultAlg: string): { alg: ReturnType<typeof parseSigningAlgorithm> } {
  let alg = defaultAlg;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--alg') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--alg needs a value');
      alg = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${String(arg)}`);
    }
  }
  return { alg: parseSigningAlgorithm('--alg', alg) };
}

async function main(): Promise<void> {
  if (config.signingKeyStore !== 'postgres') {
    throw new Error('Rotation applies to SIGNING_KEY_STORE=postgres; with the env store, change the key settings instead');
  }
  const { alg } = parseRotateArgs(process.argv.slice(2), config.jwtSigningAlg);
  const sql = getSql();
  try {
    await runMigrations(sql);
    const result = await rotatePostgresSigningKey(sql, alg);
    console.log(JSON.stringify({ rotated: true, ...result }));
  } finally {
    await closeSql();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`rotate-signing-key failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
