import { describe, it, expect } from 'vitest';
import { openPostgresStorage } from '../docs/examples/postgres-storage.js';
import { openRedisStorage } from '../docs/examples/redis-storage.js';
import { databaseUrl, redisUrl } from './env.js';

// The storage examples embedded in docs/mcp-auth.md, run against real servers.
(databaseUrl ? describe : describe.skip)('docs example: Postgres storage', () => {
  it('migrates, stores and consumes a code once', async () => {
    const { storage, close } = await openPostgresStorage(databaseUrl!);
    try {
      const record = {
        clientId: 'docs-client',
        redirectUri: 'https://app.example.com/callback',
        codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
        codeChallengeMethod: 'S256' as const,
        scopes: ['tool:acme_kyb:read'],
        resource: 'https://mcp.acme.example.com/mcp',
        grantexAuthRequestId: 'areq_docs',
        expiresAt: Date.now() + 60_000,
      };
      await storage.putAuthorizationCode('docs-example-code', record);
      expect(await storage.consumeAuthorizationCode('docs-example-code')).toEqual(record);
      expect(await storage.consumeAuthorizationCode('docs-example-code')).toBeUndefined();
    } finally {
      await close();
    }
  });
});

(redisUrl ? describe : describe.skip)('docs example: Redis storage', () => {
  it('stores and revokes', async () => {
    const { storage, close } = openRedisStorage(redisUrl!, `grantex:mcp-auth:docs:${process.pid}:`);
    try {
      await storage.revokeToken('grnt_docs_example', { revokedAt: Date.now(), expiresAt: Date.now() + 5_000 });
      expect(await storage.isTokenRevoked('grnt_docs_example')).toBe(true);
    } finally {
      await close();
    }
  });
});
