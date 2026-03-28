import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { agentsCommand } from '../src/commands/agents.js';
import { setJsonMode } from '../src/format.js';

const mockClient = {
  agents: {
    list: vi.fn(),
    register: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

describe('agentsCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "agents" command name', () => {
    const cmd = agentsCommand();
    expect(cmd.name()).toBe('agents');
  });

  it('has list, register, get, update, delete subcommands', () => {
    const cmd = agentsCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('register');
    expect(names).toContain('get');
    expect(names).toContain('update');
    expect(names).toContain('delete');
  });

  // ── list ──────────────────────────────────────────────────────────────

  it('list calls agents.list and prints table', async () => {
    mockClient.agents.list.mockResolvedValue({
      agents: [
        {
          agentId: 'ag_1',
          did: 'did:grantex:ag_1',
          name: 'Bot',
          description: 'test',
          scopes: ['email:read'],
          status: 'active',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.agents.list).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  it('list prints "(no results)" for empty list', async () => {
    mockClient.agents.list.mockResolvedValue({ agents: [] });
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.agents.list).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith('(no results)');
  });

  it('list --json outputs JSON array', async () => {
    const agent = {
      agentId: 'ag_1',
      did: 'did:grantex:ag_1',
      name: 'Bot',
      description: 'test',
      scopes: ['email:read'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockClient.agents.list.mockResolvedValue({ agents: [agent] });
    setJsonMode(true);
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"agentId"'));
  });

  // ── register ──────────────────────────────────────────────────────────

  it('register calls agents.register with parsed options', async () => {
    mockClient.agents.register.mockResolvedValue({
      agentId: 'ag_2',
      did: 'did:grantex:ag_2',
      name: 'NewBot',
      description: 'A new bot',
      scopes: ['email:read', 'calendar:write'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'register',
      '--name',
      'NewBot',
      '--description',
      'A new bot',
      '--scopes',
      'email:read, calendar:write',
    ]);
    expect(mockClient.agents.register).toHaveBeenCalledWith({
      name: 'NewBot',
      description: 'A new bot',
      scopes: ['email:read', 'calendar:write'],
    });
    expect(console.log).toHaveBeenCalled();
  });

  it('register --json outputs JSON', async () => {
    const agent = {
      agentId: 'ag_2',
      did: 'did:grantex:ag_2',
      name: 'NewBot',
      description: 'A new bot',
      scopes: ['email:read'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockClient.agents.register.mockResolvedValue(agent);
    setJsonMode(true);
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'register',
      '--name',
      'NewBot',
      '--description',
      'A new bot',
      '--scopes',
      'email:read',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.agentId).toBe('ag_2');
  });

  // ── get ───────────────────────────────────────────────────────────────

  it('get calls agents.get with agentId', async () => {
    mockClient.agents.get.mockResolvedValue({
      agentId: 'ag_1',
      did: 'did:grantex:ag_1',
      name: 'Bot',
      description: 'test',
      scopes: ['email:read'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'ag_1']);
    expect(mockClient.agents.get).toHaveBeenCalledWith('ag_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('get --json outputs JSON object', async () => {
    const agent = {
      agentId: 'ag_1',
      did: 'did:grantex:ag_1',
      name: 'Bot',
      description: 'test',
      scopes: ['email:read'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockClient.agents.get.mockResolvedValue(agent);
    setJsonMode(true);
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'ag_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.agentId).toBe('ag_1');
    expect(parsed.name).toBe('Bot');
  });

  // ── update ────────────────────────────────────────────────────────────

  it('update calls agents.update with changed fields', async () => {
    mockClient.agents.update.mockResolvedValue({
      agentId: 'ag_1',
      did: 'did:grantex:ag_1',
      name: 'Updated Bot',
      description: 'test',
      scopes: ['email:read'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'update', 'ag_1', '--name', 'Updated Bot']);
    expect(mockClient.agents.update).toHaveBeenCalledWith('ag_1', { name: 'Updated Bot' });
    expect(console.log).toHaveBeenCalled();
  });

  it('update passes scopes as array when --scopes is provided', async () => {
    mockClient.agents.update.mockResolvedValue({
      agentId: 'ag_1',
      did: 'did:grantex:ag_1',
      name: 'Bot',
      description: 'test',
      scopes: ['email:read', 'calendar:write'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node',
      'test',
      'update',
      'ag_1',
      '--scopes',
      'email:read, calendar:write',
    ]);
    expect(mockClient.agents.update).toHaveBeenCalledWith('ag_1', {
      scopes: ['email:read', 'calendar:write'],
    });
  });

  it('update --json outputs JSON', async () => {
    const agent = {
      agentId: 'ag_1',
      did: 'did:grantex:ag_1',
      name: 'Updated',
      description: 'test',
      scopes: ['email:read'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    };
    mockClient.agents.update.mockResolvedValue(agent);
    setJsonMode(true);
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'update', 'ag_1', '--name', 'Updated']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.name).toBe('Updated');
  });

  // ── delete ────────────────────────────────────────────────────────────

  it('delete calls agents.delete with agentId', async () => {
    mockClient.agents.delete.mockResolvedValue(undefined);
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'ag_1']);
    expect(mockClient.agents.delete).toHaveBeenCalledWith('ag_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('delete --json outputs JSON', async () => {
    mockClient.agents.delete.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = agentsCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'ag_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.deleted).toBe('ag_1');
  });
});
