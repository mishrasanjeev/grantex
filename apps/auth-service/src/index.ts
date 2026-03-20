import { initTracing } from './lib/tracing.js';
import { config } from './config.js';
import { initKeys, initEdKey } from './lib/crypto.js';
import { getSql } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { getRedis } from './redis/client.js';
import { buildApp } from './server.js';
import { hashApiKey } from './lib/hash.js';
import { newDeveloperId } from './lib/ids.js';
import { startWebhookDeliveryWorker } from './workers/webhookDelivery.js';
import { startAnomalyDetectionWorker } from './workers/anomalyDetection.js';
import { seedTrustRegistry } from './db/seeds/trust-registry.js';

async function main() {
  // Initialize OpenTelemetry tracing (must be first — hooks module loading)
  await initTracing();

  // Initialize RSA keys
  await initKeys();

  // Initialize Ed25519 key (optional — for DID / VC support)
  await initEdKey();

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

  // Seed trust registry with demo orgs (idempotent)
  await seedTrustRegistry();

  const app = await buildApp({ logger: true });

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Start background workers after the server is listening
  startWebhookDeliveryWorker(sql);
  startAnomalyDetectionWorker(sql);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
