import { describe, it, expect, vi, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

// Minimal stub — we only need the shape so buildServer() can register tools.
const grantex = {
  agents: { register: vi.fn(), list: vi.fn(), get: vi.fn(), update: vi.fn(), delete: vi.fn() },
  authorize: vi.fn(),
  tokens: { exchange: vi.fn(), verify: vi.fn(), revoke: vi.fn(), refresh: vi.fn() },
  grants: { list: vi.fn(), get: vi.fn(), revoke: vi.fn(), delegate: vi.fn() },
  audit: { log: vi.fn(), list: vi.fn() },
  principalSessions: { create: vi.fn() },
} as never;

const EXPECTED_TOOLS = [
  'grantex_agent_register',
  'grantex_agent_list',
  'grantex_agent_get',
  'grantex_agent_update',
  'grantex_agent_delete',
  'grantex_authorize',
  'grantex_token_exchange',
  'grantex_token_verify',
  'grantex_token_revoke',
  'grantex_token_refresh',
  'grantex_grant_list',
  'grantex_grant_get',
  'grantex_grant_revoke',
  'grantex_grant_delegate',
  'grantex_audit_log',
  'grantex_audit_list',
  'grantex_principal_session_create',
];

describe('buildServer()', () => {
  let toolNames: string[];

  beforeAll(async () => {
    const server = buildServer(grantex);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    const { tools } = await client.listTools();
    toolNames = tools.map((t) => t.name);

    await client.close();
    await server.close();
  });

  it('registers all 17 tools', () => {
    expect(toolNames).toHaveLength(17);
  });

  it.each(EXPECTED_TOOLS)('registers %s', (name) => {
    expect(toolNames).toContain(name);
  });
});
