import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

// ---------------------------------------------------------------------------
// Mock SDK client
// ---------------------------------------------------------------------------
function createMockGrantex() {
  return {
    agents: {
      register: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    authorize: vi.fn(),
    tokens: {
      exchange: vi.fn(),
      verify: vi.fn(),
      revoke: vi.fn(),
      refresh: vi.fn(),
    },
    grants: {
      list: vi.fn(),
      get: vi.fn(),
      revoke: vi.fn(),
      delegate: vi.fn(),
    },
    audit: { log: vi.fn(), list: vi.fn() },
    principalSessions: { create: vi.fn() },
  };
}

type MockGrantex = ReturnType<typeof createMockGrantex>;

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

// ---------------------------------------------------------------------------
// Helper: create a connected client + server pair
// ---------------------------------------------------------------------------
async function createClientServer(grantex: MockGrantex) {
  const server = buildServer(grantex as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return { client, server };
}

// Helper to extract text from a tool call result
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const item = result.content[0];
  if (item && 'text' in item) return item.text as string;
  throw new Error('No text content');
}

// ---------------------------------------------------------------------------
// Tool registration (smoke tests)
// ---------------------------------------------------------------------------
describe('buildServer() — tool registration', () => {
  let toolNames: string[];

  beforeAll(async () => {
    const grantex = createMockGrantex();
    const { client, server } = await createClientServer(grantex);

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

// ---------------------------------------------------------------------------
// Tool handler tests
// ---------------------------------------------------------------------------
describe('tool handlers', () => {
  let grantex: MockGrantex;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    grantex = createMockGrantex();
    const pair = await createClientServer(grantex);
    client = pair.client;
    cleanup = async () => {
      await pair.client.close();
      await pair.server.close();
    };
  });

  // We need to cleanup after each to avoid port/transport leaks.
  // vitest doesn't have afterEach in the same scope easily, so we call it inline.

  // -----------------------------------------------------------------------
  // Agent tools
  // -----------------------------------------------------------------------
  describe('grantex_agent_register', () => {
    it('returns registered agent as JSON', async () => {
      const agent = { id: 'ag_123', name: 'TestBot', scopes: ['read'] };
      grantex.agents.register.mockResolvedValue(agent);

      const result = await client.callTool({
        name: 'grantex_agent_register',
        arguments: { name: 'TestBot', description: 'A test bot', scopes: ['read'] },
      });

      expect(grantex.agents.register).toHaveBeenCalledWith({
        name: 'TestBot',
        description: 'A test bot',
        scopes: ['read'],
      });
      expect(JSON.parse(textOf(result as never))).toEqual(agent);

      await cleanup();
    });

    it('returns isError when SDK throws', async () => {
      grantex.agents.register.mockRejectedValue(new Error('Forbidden'));

      const result = await client.callTool({
        name: 'grantex_agent_register',
        arguments: { name: 'X', description: 'Y', scopes: [] },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result as never)).toBe('Forbidden');

      await cleanup();
    });
  });

  describe('grantex_agent_list', () => {
    it('returns agents array as JSON', async () => {
      const agents = { agents: [{ id: 'ag_1' }, { id: 'ag_2' }] };
      grantex.agents.list.mockResolvedValue(agents);

      const result = await client.callTool({
        name: 'grantex_agent_list',
        arguments: {},
      });

      expect(grantex.agents.list).toHaveBeenCalled();
      expect(JSON.parse(textOf(result as never))).toEqual(agents);

      await cleanup();
    });
  });

  describe('grantex_agent_get', () => {
    it('returns a single agent', async () => {
      const agent = { id: 'ag_42', name: 'Agent42' };
      grantex.agents.get.mockResolvedValue(agent);

      const result = await client.callTool({
        name: 'grantex_agent_get',
        arguments: { agentId: 'ag_42' },
      });

      expect(grantex.agents.get).toHaveBeenCalledWith('ag_42');
      expect(JSON.parse(textOf(result as never))).toEqual(agent);

      await cleanup();
    });

    it('returns isError for not-found', async () => {
      grantex.agents.get.mockRejectedValue(new Error('Not found'));

      const result = await client.callTool({
        name: 'grantex_agent_get',
        arguments: { agentId: 'ag_missing' },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result as never)).toBe('Not found');

      await cleanup();
    });
  });

  describe('grantex_agent_update', () => {
    it('sends only provided fields', async () => {
      const updated = { id: 'ag_1', name: 'Renamed' };
      grantex.agents.update.mockResolvedValue(updated);

      const result = await client.callTool({
        name: 'grantex_agent_update',
        arguments: { agentId: 'ag_1', name: 'Renamed' },
      });

      expect(grantex.agents.update).toHaveBeenCalledWith('ag_1', { name: 'Renamed' });
      expect(JSON.parse(textOf(result as never))).toEqual(updated);

      await cleanup();
    });

    it('sends all fields when provided', async () => {
      const updated = { id: 'ag_1', name: 'New', description: 'Desc', scopes: ['write'] };
      grantex.agents.update.mockResolvedValue(updated);

      await client.callTool({
        name: 'grantex_agent_update',
        arguments: { agentId: 'ag_1', name: 'New', description: 'Desc', scopes: ['write'] },
      });

      expect(grantex.agents.update).toHaveBeenCalledWith('ag_1', {
        name: 'New',
        description: 'Desc',
        scopes: ['write'],
      });

      await cleanup();
    });
  });

  describe('grantex_agent_delete', () => {
    it('returns success message', async () => {
      grantex.agents.delete.mockResolvedValue(undefined);

      const result = await client.callTool({
        name: 'grantex_agent_delete',
        arguments: { agentId: 'ag_99' },
      });

      expect(grantex.agents.delete).toHaveBeenCalledWith('ag_99');
      expect(textOf(result as never)).toBe('Agent ag_99 deleted successfully.');

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Authorize tool
  // -----------------------------------------------------------------------
  describe('grantex_authorize', () => {
    it('returns consent URL and auth request id', async () => {
      const authResult = {
        authRequestId: 'ar_abc',
        consentUrl: 'https://example.com/consent',
        expiresAt: '2026-12-31T00:00:00Z',
      };
      grantex.authorize.mockResolvedValue(authResult);

      const result = await client.callTool({
        name: 'grantex_authorize',
        arguments: {
          agentId: 'ag_1',
          userId: 'user_1',
          scopes: ['read', 'write'],
        },
      });

      expect(grantex.authorize).toHaveBeenCalledWith({
        agentId: 'ag_1',
        userId: 'user_1',
        scopes: ['read', 'write'],
      });
      expect(JSON.parse(textOf(result as never))).toEqual(authResult);

      await cleanup();
    });

    it('passes optional expiresIn and redirectUri', async () => {
      grantex.authorize.mockResolvedValue({ authRequestId: 'ar_1' });

      await client.callTool({
        name: 'grantex_authorize',
        arguments: {
          agentId: 'ag_1',
          userId: 'user_1',
          scopes: ['read'],
          expiresIn: '24h',
          redirectUri: 'https://app.test/callback',
        },
      });

      expect(grantex.authorize).toHaveBeenCalledWith({
        agentId: 'ag_1',
        userId: 'user_1',
        scopes: ['read'],
        expiresIn: '24h',
        redirectUri: 'https://app.test/callback',
      });

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Token tools
  // -----------------------------------------------------------------------
  describe('grantex_token_exchange', () => {
    it('returns token response', async () => {
      const tokenResponse = {
        grantToken: 'jwt.token.here',
        expiresAt: '2026-12-31T00:00:00Z',
        scopes: ['read'],
        refreshToken: 'rt_abc',
        grantId: 'grnt_1',
      };
      grantex.tokens.exchange.mockResolvedValue(tokenResponse);

      const result = await client.callTool({
        name: 'grantex_token_exchange',
        arguments: { code: 'auth_code_abc', agentId: 'ag_1' },
      });

      expect(grantex.tokens.exchange).toHaveBeenCalledWith({
        code: 'auth_code_abc',
        agentId: 'ag_1',
      });
      expect(JSON.parse(textOf(result as never))).toEqual(tokenResponse);

      await cleanup();
    });
  });

  describe('grantex_token_verify', () => {
    it('returns verification result', async () => {
      const verifyResult = {
        valid: true,
        grantId: 'grnt_1',
        scopes: ['read'],
        principal: 'user_1',
        agent: 'ag_1',
        expiresAt: '2026-12-31T00:00:00Z',
      };
      grantex.tokens.verify.mockResolvedValue(verifyResult);

      const result = await client.callTool({
        name: 'grantex_token_verify',
        arguments: { token: 'jwt.token.here' },
      });

      expect(grantex.tokens.verify).toHaveBeenCalledWith('jwt.token.here');
      expect(JSON.parse(textOf(result as never))).toEqual(verifyResult);

      await cleanup();
    });

    it('returns valid=false for invalid tokens', async () => {
      const verifyResult = { valid: false };
      grantex.tokens.verify.mockResolvedValue(verifyResult);

      const result = await client.callTool({
        name: 'grantex_token_verify',
        arguments: { token: 'bad.token' },
      });

      expect(JSON.parse(textOf(result as never))).toEqual(verifyResult);

      await cleanup();
    });
  });

  describe('grantex_token_revoke', () => {
    it('returns success message', async () => {
      grantex.tokens.revoke.mockResolvedValue(undefined);

      const result = await client.callTool({
        name: 'grantex_token_revoke',
        arguments: { tokenId: 'jti_abc' },
      });

      expect(grantex.tokens.revoke).toHaveBeenCalledWith('jti_abc');
      expect(textOf(result as never)).toBe('Token revoked successfully.');

      await cleanup();
    });
  });

  describe('grantex_token_refresh', () => {
    it('returns refreshed token response', async () => {
      const refreshResult = {
        grantToken: 'new.jwt.token',
        expiresAt: '2026-12-31T00:00:00Z',
        scopes: ['read'],
        refreshToken: 'rt_new',
        grantId: 'grnt_1',
      };
      grantex.tokens.refresh.mockResolvedValue(refreshResult);

      const result = await client.callTool({
        name: 'grantex_token_refresh',
        arguments: { refreshToken: 'rt_old', agentId: 'ag_1' },
      });

      expect(grantex.tokens.refresh).toHaveBeenCalledWith({
        refreshToken: 'rt_old',
        agentId: 'ag_1',
      });
      expect(JSON.parse(textOf(result as never))).toEqual(refreshResult);

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Grant tools
  // -----------------------------------------------------------------------
  describe('grantex_grant_list', () => {
    it('returns grants with no filters', async () => {
      const grants = { grants: [{ id: 'grnt_1' }] };
      grantex.grants.list.mockResolvedValue(grants);

      const result = await client.callTool({
        name: 'grantex_grant_list',
        arguments: {},
      });

      expect(grantex.grants.list).toHaveBeenCalledWith({});
      expect(JSON.parse(textOf(result as never))).toEqual(grants);

      await cleanup();
    });

    it('passes optional filters', async () => {
      grantex.grants.list.mockResolvedValue({ grants: [] });

      await client.callTool({
        name: 'grantex_grant_list',
        arguments: { agentId: 'ag_1', status: 'active' },
      });

      expect(grantex.grants.list).toHaveBeenCalledWith({
        agentId: 'ag_1',
        status: 'active',
      });

      await cleanup();
    });
  });

  describe('grantex_grant_get', () => {
    it('returns a single grant', async () => {
      const grant = { id: 'grnt_1', status: 'active', scopes: ['read'] };
      grantex.grants.get.mockResolvedValue(grant);

      const result = await client.callTool({
        name: 'grantex_grant_get',
        arguments: { grantId: 'grnt_1' },
      });

      expect(grantex.grants.get).toHaveBeenCalledWith('grnt_1');
      expect(JSON.parse(textOf(result as never))).toEqual(grant);

      await cleanup();
    });
  });

  describe('grantex_grant_revoke', () => {
    it('returns success message', async () => {
      grantex.grants.revoke.mockResolvedValue(undefined);

      const result = await client.callTool({
        name: 'grantex_grant_revoke',
        arguments: { grantId: 'grnt_42' },
      });

      expect(grantex.grants.revoke).toHaveBeenCalledWith('grnt_42');
      expect(textOf(result as never)).toBe('Grant grnt_42 revoked successfully.');

      await cleanup();
    });
  });

  describe('grantex_grant_delegate', () => {
    it('returns delegated grant response', async () => {
      const delegated = {
        grantToken: 'delegated.jwt',
        expiresAt: '2026-12-31T00:00:00Z',
        scopes: ['read'],
        grantId: 'grnt_child',
      };
      grantex.grants.delegate.mockResolvedValue(delegated);

      const result = await client.callTool({
        name: 'grantex_grant_delegate',
        arguments: {
          parentGrantToken: 'parent.jwt',
          subAgentId: 'ag_sub',
          scopes: ['read'],
        },
      });

      expect(grantex.grants.delegate).toHaveBeenCalledWith({
        parentGrantToken: 'parent.jwt',
        subAgentId: 'ag_sub',
        scopes: ['read'],
      });
      expect(JSON.parse(textOf(result as never))).toEqual(delegated);

      await cleanup();
    });

    it('passes optional expiresIn', async () => {
      grantex.grants.delegate.mockResolvedValue({ grantToken: 'x' });

      await client.callTool({
        name: 'grantex_grant_delegate',
        arguments: {
          parentGrantToken: 'parent.jwt',
          subAgentId: 'ag_sub',
          scopes: ['read'],
          expiresIn: '1h',
        },
      });

      expect(grantex.grants.delegate).toHaveBeenCalledWith({
        parentGrantToken: 'parent.jwt',
        subAgentId: 'ag_sub',
        scopes: ['read'],
        expiresIn: '1h',
      });

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Audit tools
  // -----------------------------------------------------------------------
  describe('grantex_audit_log', () => {
    it('logs an audit entry with required fields', async () => {
      const entry = { id: 'aud_1', action: 'read_email', status: 'success' };
      grantex.audit.log.mockResolvedValue(entry);

      const result = await client.callTool({
        name: 'grantex_audit_log',
        arguments: {
          agentId: 'ag_1',
          agentDid: 'did:key:z6Mk123',
          grantId: 'grnt_1',
          principalId: 'user_1',
          action: 'read_email',
        },
      });

      expect(grantex.audit.log).toHaveBeenCalledWith({
        agentId: 'ag_1',
        agentDid: 'did:key:z6Mk123',
        grantId: 'grnt_1',
        principalId: 'user_1',
        action: 'read_email',
      });
      expect(JSON.parse(textOf(result as never))).toEqual(entry);

      await cleanup();
    });

    it('passes optional metadata and status', async () => {
      grantex.audit.log.mockResolvedValue({ id: 'aud_2' });

      await client.callTool({
        name: 'grantex_audit_log',
        arguments: {
          agentId: 'ag_1',
          agentDid: 'did:key:z6Mk123',
          grantId: 'grnt_1',
          principalId: 'user_1',
          action: 'send_message',
          metadata: { to: 'alice@example.com' },
          status: 'success',
        },
      });

      expect(grantex.audit.log).toHaveBeenCalledWith({
        agentId: 'ag_1',
        agentDid: 'did:key:z6Mk123',
        grantId: 'grnt_1',
        principalId: 'user_1',
        action: 'send_message',
        metadata: { to: 'alice@example.com' },
        status: 'success',
      });

      await cleanup();
    });
  });

  describe('grantex_audit_list', () => {
    it('lists audit entries with no filters', async () => {
      const entries = { entries: [{ id: 'aud_1' }] };
      grantex.audit.list.mockResolvedValue(entries);

      const result = await client.callTool({
        name: 'grantex_audit_list',
        arguments: {},
      });

      expect(grantex.audit.list).toHaveBeenCalledWith({});
      expect(JSON.parse(textOf(result as never))).toEqual(entries);

      await cleanup();
    });

    it('passes all optional filters', async () => {
      grantex.audit.list.mockResolvedValue({ entries: [] });

      await client.callTool({
        name: 'grantex_audit_list',
        arguments: {
          agentId: 'ag_1',
          grantId: 'grnt_1',
          action: 'read_email',
          since: '2026-01-01T00:00:00Z',
          until: '2026-12-31T00:00:00Z',
        },
      });

      expect(grantex.audit.list).toHaveBeenCalledWith({
        agentId: 'ag_1',
        grantId: 'grnt_1',
        action: 'read_email',
        since: '2026-01-01T00:00:00Z',
        until: '2026-12-31T00:00:00Z',
      });

      await cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Principal session tool
  // -----------------------------------------------------------------------
  describe('grantex_principal_session_create', () => {
    it('creates a session with required principalId', async () => {
      const session = {
        sessionToken: 'sess_jwt',
        dashboardUrl: 'https://grantex.dev/dashboard?token=sess_jwt',
        expiresAt: '2026-12-31T00:00:00Z',
      };
      grantex.principalSessions.create.mockResolvedValue(session);

      const result = await client.callTool({
        name: 'grantex_principal_session_create',
        arguments: { principalId: 'user_1' },
      });

      expect(grantex.principalSessions.create).toHaveBeenCalledWith({
        principalId: 'user_1',
      });
      expect(JSON.parse(textOf(result as never))).toEqual(session);

      await cleanup();
    });

    it('passes optional expiresIn', async () => {
      grantex.principalSessions.create.mockResolvedValue({ sessionToken: 'tok' });

      await client.callTool({
        name: 'grantex_principal_session_create',
        arguments: { principalId: 'user_1', expiresIn: '30m' },
      });

      expect(grantex.principalSessions.create).toHaveBeenCalledWith({
        principalId: 'user_1',
        expiresIn: '30m',
      });

      await cleanup();
    });
  });
});
