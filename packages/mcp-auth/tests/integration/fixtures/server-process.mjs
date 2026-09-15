// A real mcp-auth server process for the restart integration test. It runs
// the built package (dist/) exactly as a deployment would: storage from the
// environment, migrations at start-up, then listen. Grantex is replaced by a
// deterministic in-process stub so the test needs no network.
//
// Environment:
//   MCP_AUTH_STORAGE       postgres | redis
//   MCP_AUTH_STORAGE_URL   connection URL for that backend
//   MCP_AUTH_REDIS_PREFIX  key prefix (redis only)
//   GRANTEX_ISSUER         issuer whose JWKS signs grant tokens
import { randomBytes } from 'node:crypto';
import { UnsecuredJWT } from 'jose';
import { createMcpAuthServer } from '../../../dist/index.js';

const RESOURCE = 'https://mcp.example.com/mcp';
// Upstream grant tokens are audience-bound to the resource, as Grantex issues them.
const grantFor = (jti) => new UnsecuredJWT({ aud: RESOURCE, jti, scp: ['tools:read'] }).setExpirationTime('1h').encode();
const kind = process.env.MCP_AUTH_STORAGE;
const url = process.env.MCP_AUTH_STORAGE_URL;

async function openStorage() {
  if (kind === 'postgres') {
    const { default: pg } = await import('pg');
    const { PostgresStorage, runMigrations } = await import('../../../dist/postgres.js');
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    await runMigrations(pool);
    return new PostgresStorage({ db: pool });
  }
  if (kind === 'redis') {
    const { Redis } = await import('ioredis');
    const { RedisStorage, fromIoredis } = await import('../../../dist/redis.js');
    const redis = new Redis(url, { maxRetriesPerRequest: 1 });
    return new RedisStorage({ redis: fromIoredis(redis), keyPrefix: process.env.MCP_AUTH_REDIS_PREFIX });
  }
  throw new Error(`unknown MCP_AUTH_STORAGE: ${kind}`);
}

const grantex = {
  async authorize(params) {
    return {
      authRequestId: `areq_${randomBytes(6).toString('hex')}`,
      // The test reads the state Grantex was given back out of this URL.
      consentUrl: `https://grantex.example.com/consent?state=${encodeURIComponent(params.state)}`,
      agentId: params.agentId,
      principalId: params.userId,
      scopes: params.scopes,
      expiresIn: '600s',
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
  },
  tokens: {
    async exchange({ code }) {
      return {
        grantToken: grantFor(`grant-for-${code}`),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['tools:read'],
        refreshToken: `rt_${randomBytes(12).toString('hex')}`,
        grantId: 'grnt_restart',
      };
    },
    async refresh() {
      return {
        grantToken: grantFor(`refreshed-${randomBytes(6).toString('hex')}`),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scopes: ['tools:read'],
        refreshToken: `rt_${randomBytes(12).toString('hex')}`,
        grantId: 'grnt_restart',
      };
    },
    async revoke() {},
  },
};

const storage = await openStorage();
const app = await createMcpAuthServer({
  grantex,
  agentId: 'ag_restart',
  scopes: ['tools:read'],
  issuer: 'https://auth.example.com',
  resource: RESOURCE,
  grantexIssuer: process.env.GRANTEX_ISSUER,
  storage,
});
await app.listen({ port: 0, host: '127.0.0.1' });
const address = app.server.address();
process.stdout.write(`LISTENING ${address.port}\n`);
