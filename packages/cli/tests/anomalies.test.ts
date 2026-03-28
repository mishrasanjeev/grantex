import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/client.js', () => ({
  requireClient: vi.fn(),
}));

import { requireClient } from '../src/client.js';
import { anomaliesCommand } from '../src/commands/anomalies.js';
import { setJsonMode } from '../src/format.js';

const sampleAnomaly = {
  id: 'anm_1',
  type: 'rate_spike',
  severity: 'high',
  agentId: 'ag_1',
  description: 'Rate spike detected',
  acknowledged: false,
};

const mockClient = {
  anomalies: {
    detect: vi.fn(),
    list: vi.fn(),
    acknowledge: vi.fn(),
  },
};

describe('anomaliesCommand()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (requireClient as ReturnType<typeof vi.fn>).mockResolvedValue(mockClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setJsonMode(false);
  });

  it('registers the "anomalies" command', () => {
    const cmd = anomaliesCommand();
    expect(cmd.name()).toBe('anomalies');
  });

  it('has detect, list, and acknowledge subcommands', () => {
    const cmd = anomaliesCommand();
    const names = cmd.commands.map((c) => c.name());
    expect(names).toContain('detect');
    expect(names).toContain('list');
    expect(names).toContain('acknowledge');
  });

  it('"list" has --unacknowledged option', () => {
    const cmd = anomaliesCommand();
    const listCmd = cmd.commands.find((c) => c.name() === 'list')!;
    const optNames = listCmd.options.map((o) => o.long);
    expect(optNames).toContain('--unacknowledged');
  });

  // ── detect action ────────────────────────────────────────────────────

  it('detect calls anomalies.detect and prints table', async () => {
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [sampleAnomaly],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    expect(mockClient.anomalies.detect).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalled();
  });

  it('detect prints no-anomalies message when total is 0', async () => {
    mockClient.anomalies.detect.mockResolvedValue({ total: 0, anomalies: [] });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('No anomalies detected');
  });

  it('detect --json outputs JSON', async () => {
    const result = { total: 1, anomalies: [sampleAnomaly] };
    mockClient.anomalies.detect.mockResolvedValue(result);
    setJsonMode(true);
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.total).toBe(1);
    expect(parsed.anomalies[0].id).toBe('anm_1');
  });

  it('detect shows singular anomaly count for total=1', async () => {
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [sampleAnomaly],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    // "1 anomaly" (not "1 anomalys")
    expect(allOutput).toContain('1 anomaly');
  });

  it('detect truncates long description to 60 chars', async () => {
    const longDesc = 'A'.repeat(80);
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [{ ...sampleAnomaly, description: longDesc }],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    expect(mockClient.anomalies.detect).toHaveBeenCalledOnce();
  });

  it('detect handles anomaly with null agentId', async () => {
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [{ ...sampleAnomaly, agentId: null }],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    expect(mockClient.anomalies.detect).toHaveBeenCalledOnce();
  });

  // ── list action ──────────────────────────────────────────────────────

  it('list calls anomalies.list and prints table', async () => {
    mockClient.anomalies.list.mockResolvedValue({
      anomalies: [sampleAnomaly],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list']);
    expect(mockClient.anomalies.list).toHaveBeenCalledWith({});
    expect(console.log).toHaveBeenCalled();
  });

  it('list --unacknowledged passes filter', async () => {
    mockClient.anomalies.list.mockResolvedValue({
      anomalies: [sampleAnomaly],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'list', '--unacknowledged']);
    expect(mockClient.anomalies.list).toHaveBeenCalledWith({ unacknowledged: true });
  });

  // ── acknowledge action ───────────────────────────────────────────────

  it('acknowledge calls anomalies.acknowledge with anomalyId', async () => {
    mockClient.anomalies.acknowledge.mockResolvedValue(undefined);
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'acknowledge', 'anm_1']);
    expect(mockClient.anomalies.acknowledge).toHaveBeenCalledWith('anm_1');
    const allOutput = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => c.join(' '))
      .join('\n');
    expect(allOutput).toContain('anm_1');
    expect(allOutput).toContain('acknowledged');
  });

  it('acknowledge --json outputs JSON', async () => {
    mockClient.anomalies.acknowledge.mockResolvedValue(undefined);
    setJsonMode(true);
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'acknowledge', 'anm_1']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const parsed = JSON.parse(output);
    expect(parsed.acknowledged).toBe('anm_1');
  });

  // ── severity colors ──────────────────────────────────────────────────

  it('detect handles medium severity', async () => {
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [{ ...sampleAnomaly, severity: 'medium' }],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    expect(mockClient.anomalies.detect).toHaveBeenCalledOnce();
  });

  it('detect handles low severity', async () => {
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [{ ...sampleAnomaly, severity: 'low' }],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    expect(mockClient.anomalies.detect).toHaveBeenCalledOnce();
  });

  it('detect handles unknown severity gracefully', async () => {
    mockClient.anomalies.detect.mockResolvedValue({
      total: 1,
      anomalies: [{ ...sampleAnomaly, severity: 'critical' }],
    });
    const cmd = anomaliesCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'detect']);
    expect(mockClient.anomalies.detect).toHaveBeenCalledOnce();
  });
});
