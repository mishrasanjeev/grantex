import { config } from './config.js';
import { initKeys } from './lib/crypto.js';
import { getSql } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { getRedis } from './redis/client.js';
import { buildApp } from './server.js';
import { hashApiKey } from './lib/hash.js';
import { newDeveloperId } from './lib/ids.js';

async function main() {
  // Initialize RSA keys
  await initKeys();

  // Initialize DB connection
  const sql = getSql();

  // Run migrations (idempotent — safe to re-run on every startup)
  await runMigrations(sql);

  // Initialize Redis connection
  const redis = getRedis();
  await redis.connect();

  // Seed a live developer API key if configured (dev only)
  if (config.seedApiKey) {
    const seedKeyHash = hashApiKey(config.seedApiKey);
    const existing = await sql`SELECT id FROM developers WHERE api_key_hash = ${seedKeyHash}`;
    if (!existing[0]) {
      const devId = newDeveloperId();
      await sql`
        INSERT INTO developers (id, api_key_hash, name, mode)
        VALUES (${devId}, ${seedKeyHash}, 'Seed Developer', 'live')
        ON CONFLICT (api_key_hash) DO NOTHING
      `;
      console.log(`Seeded live developer: id=${devId}`);
    }
  }

  // Seed a sandbox developer API key if configured (dev only)
  if (config.seedSandboxKey) {
    const sandboxKeyHash = hashApiKey(config.seedSandboxKey);
    const existing = await sql`SELECT id FROM developers WHERE api_key_hash = ${sandboxKeyHash}`;
    if (!existing[0]) {
      const devId = newDeveloperId();
      await sql`
        INSERT INTO developers (id, api_key_hash, name, mode)
        VALUES (${devId}, ${sandboxKeyHash}, 'Seed Sandbox Developer', 'sandbox')
        ON CONFLICT (api_key_hash) DO NOTHING
      `;
      console.log(`Seeded sandbox developer: id=${devId}`);
    }
  }

  const app = await buildApp({ logger: true });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
