import { describe, it, expect, afterEach, vi } from 'vitest';
import { InMemoryStorage } from '../src/storage/memory.js';
import { createMcpAuthServer } from '../src/server.js';
import type { McpAuthConfig } from '../src/types.js';
import { describeStorageContract } from './storage-contract.js';

// In-memory storage has no persisted form, so the contract's "not stored in
// the clear" checks run only against Postgres and Redis (integration suite).
describeStorageContract('memory', async () => ({ storage: new InMemoryStorage() }), { noDump: true });

describe('InMemoryStorage guard rails', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to start with NODE_ENV=production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => new InMemoryStorage()).toThrow(/tests only/);
  });

  it('returns copies, so callers cannot mutate stored state', async () => {
    const storage = new InMemoryStorage();
    const record = {
      clientId: 'client-a',
      redirectUris: ['https://app.example.com/callback'],
      grantTypes: ['authorization_code'],
      createdAt: new Date().toISOString(),
    };
    await storage.putClient(record);
    record.redirectUris.push('https://attacker.example.org/callback');
    expect((await storage.getClient('client-a'))?.redirectUris).toEqual(['https://app.example.com/callback']);
  });
});

describe('createMcpAuthServer storage requirement', () => {
  const base = {
    grantex: {} as McpAuthConfig['grantex'],
    agentId: 'agent-1',
    scopes: ['read'],
    issuer: 'https://auth.example.com',
  };

  it('fails closed without storage', async () => {
    await expect(createMcpAuthServer(base as unknown as McpAuthConfig)).rejects.toThrow(/storage.*required/);
  });

  it('rejects a storage object that does not implement the interface', async () => {
    await expect(
      createMcpAuthServer({ ...base, storage: { kind: 'broken', getClient: async () => undefined } } as unknown as McpAuthConfig),
    ).rejects.toThrow(/does not implement/);
  });

  it('names the removed 2.x store options', async () => {
    await expect(
      createMcpAuthServer({ ...base, storage: new InMemoryStorage(), codeStore: {} } as unknown as McpAuthConfig),
    ).rejects.toThrow(/codeStore was removed in 3\.0/);
  });
});
