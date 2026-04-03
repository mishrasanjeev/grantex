import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Mock client so commands don't try to connect
vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

// We need to mock config too since the config command uses it
vi.mock('../src/config.js', () => ({
  defaultConfigPath: vi.fn().mockReturnValue('/mock/.grantex/config.json'),
  loadConfig: vi.fn().mockResolvedValue(null),
  resolveConfig: vi.fn().mockReturnValue(null),
  saveConfig: vi.fn(),
}));

import { createProgram } from '../src/index.js';
import { setJsonMode, isJsonMode } from '../src/format.js';

describe('createProgram()', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setJsonMode(false);
  });

  it('returns a program with the correct name', () => {
    const program = createProgram();
    expect(program.name()).toBe('grantex');
  });

  it('has the correct description', () => {
    const program = createProgram();
    expect(program.description()).toBe('CLI for the Grantex delegated authorization protocol');
  });

  it('has the correct version', () => {
    const program = createProgram();
    expect(program.version()).toBe('0.1.7');
  });

  it('has a --json global option', () => {
    const program = createProgram();
    const jsonOpt = program.options.find((o) => o.long === '--json');
    expect(jsonOpt).toBeDefined();
  });

  it('registers all 28 expected commands', () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name());

    const expected = [
      'config', 'me', 'agents', 'authorize', 'grants', 'tokens',
      'audit', 'webhooks', 'policies', 'budgets', 'usage', 'domains',
      'events', 'principal-sessions', 'credentials', 'passports',
      'vault', 'webauthn', 'compliance', 'anomalies', 'billing',
      'scim', 'sso', 'verify', 'decode', 'audit-log', 'registry',
      'init',
    ];

    for (const name of expected) {
      expect(names).toContain(name);
    }

    expect(names.length).toBe(expected.length);
  });

  it('preAction hook sets json mode when --json is passed', async () => {
    setJsonMode(false);
    const program = createProgram();

    // Add a dummy command to trigger preAction
    program.command('test-cmd').action(() => {});
    program.exitOverride();
    await program.parseAsync(['node', 'grantex', '--json', 'test-cmd']);

    expect(isJsonMode()).toBe(true);
  });

  it('preAction hook does not set json mode when --json is not passed', async () => {
    setJsonMode(false);
    const program = createProgram();

    program.command('test-cmd').action(() => {});
    program.exitOverride();
    await program.parseAsync(['node', 'grantex', 'test-cmd']);

    expect(isJsonMode()).toBe(false);
  });
});
