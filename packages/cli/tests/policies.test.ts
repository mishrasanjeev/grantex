import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { policiesCommand } from '../src/commands/policies.js';
import { setJsonMode } from '../src/format.js';

const samplePolicy = {
  id: 'pol_1',
  name: 'Test',
  effect: 'allow',
  priority: 100,
  agentId: null,
  principalId: null,
  scopes: null,
  timeOfDayStart: null,
  timeOfDayEnd: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const mockClient = {
  policies: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

describe('policiesCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "policies" command', () => {
    const cmd = policiesCommand();
    expect(cmd.name()).toBe('policies');
  });

  it('has list, get, create, update, and delete subcommands', () => {
    const cmd = policiesCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('list');
    expect(names).toContain('get');
    expect(names).toContain('create');
    expect(names).toContain('update');
    expect(names).toContain('delete');
  });

  it('"create" has --name, --effect, --priority, --scopes options', () => {
    const cmd = policiesCommand();
    const createCmd = cmd.commands.find((c) => c.name() === 'create')!;
    const optNames = createCmd.options.map((o) => o.long);
    expect(optNames).toContain('--name');
    expect(optNames).toContain('--effect');
    expect(optNames).toContain('--priority');
    expect(optNames).toContain('--scopes');
  });

  it('"create" has --time-start and --time-end options', () => {
    const cmd = policiesCommand();
    const createCmd = cmd.commands.find((c) => c.name() === 'create')!;
    const optNames = createCmd.options.map((o) => o.long);
    expect(optNames).toContain('--time-start');
    expect(optNames).toContain('--time-end');
  });

  // ── list action ──────────────────────────────────────────────────────

  it('list calls policies.list and prints table', async () => {
    mockClient.policies.list.mockResolvedValue({ policies: [samplePolicy] });
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.policies.list).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  // ── get action ───────────────────────────────────────────────────────

  it('get calls policies.get and prints record', async () => {
    mockClient.policies.get.mockResolvedValue(samplePolicy);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'pol_1']);
    expect(mockClient.policies.get).toHaveBeenCalledWith('pol_1');
    expect(console.log).toHaveBeenCalled();
  });

  it('get --json outputs JSON', async () => {
    mockClient.policies.get.mockResolvedValue(samplePolicy);
    setJsonMode(true);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'pol_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('pol_1');
    expect(parsed.name).toBe('Test');
  });

  it('get displays scopes when present', async () => {
    const withScopes = { ...samplePolicy, scopes: ['email:read', 'calendar:write'] };
    mockClient.policies.get.mockResolvedValue(withScopes);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'get', 'pol_1']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('email:read');
  });

  // ── create action ────────────────────────────────────────────────────

  it('create calls policies.create with required options', async () => {
    mockClient.policies.create.mockResolvedValue(samplePolicy);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'create',
      '--name', 'Test',
      '--effect', 'allow',
    ]);
    expect(mockClient.policies.create).toHaveBeenCalledWith({
      name: 'Test',
      effect: 'allow',
      priority: 100,
    });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('pol_1');
  });

  it('create passes all optional fields', async () => {
    mockClient.policies.create.mockResolvedValue(samplePolicy);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'create',
      '--name', 'Test',
      '--effect', 'deny',
      '--priority', '50',
      '--agent-id', 'ag_1',
      '--principal-id', 'user@test.com',
      '--scopes', 'email:read, calendar:write',
      '--time-start', '09:00',
      '--time-end', '17:00',
    ]);
    expect(mockClient.policies.create).toHaveBeenCalledWith({
      name: 'Test',
      effect: 'deny',
      priority: 50,
      agentId: 'ag_1',
      principalId: 'user@test.com',
      scopes: ['email:read', 'calendar:write'],
      timeOfDayStart: '09:00',
      timeOfDayEnd: '17:00',
    });
  });

  it('create --json outputs JSON', async () => {
    mockClient.policies.create.mockResolvedValue(samplePolicy);
    setJsonMode(true);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'create',
      '--name', 'Test',
      '--effect', 'allow',
    ]);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('pol_1');
  });

  // ── update action ────────────────────────────────────────────────────

  it('update calls policies.update with changed fields', async () => {
    const updatedPolicy = { ...samplePolicy, name: 'Updated' };
    mockClient.policies.update.mockResolvedValue(updatedPolicy);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'update', 'pol_1', '--name', 'Updated']);
    expect(mockClient.policies.update).toHaveBeenCalledWith('pol_1', { name: 'Updated' });
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('pol_1');
  });

  it('update passes effect and priority', async () => {
    mockClient.policies.update.mockResolvedValue(samplePolicy);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync([
      'node', 'test', 'update', 'pol_1',
      '--effect', 'deny',
      '--priority', '10',
    ]);
    expect(mockClient.policies.update).toHaveBeenCalledWith('pol_1', {
      effect: 'deny',
      priority: 10,
    });
  });

  it('update --json outputs JSON', async () => {
    mockClient.policies.update.mockResolvedValue(samplePolicy);
    setJsonMode(true);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'update', 'pol_1', '--name', 'Updated']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.id).toBe('pol_1');
  });

  // ── delete action ────────────────────────────────────────────────────

  it('delete calls policies.delete with policyId', async () => {
    mockClient.policies.delete.mockResolvedValue(undefined);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'pol_1']);
    expect(mockClient.policies.delete).toHaveBeenCalledWith('pol_1');
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('pol_1');
    expect(allOutput).toContain('deleted');
  });

  it('delete --json outputs JSON', async () => {
    mockClient.policies.delete.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = policiesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'delete', 'pol_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.deleted).toBe('pol_1');
  });
});
