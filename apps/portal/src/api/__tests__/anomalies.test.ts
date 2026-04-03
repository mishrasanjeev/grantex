import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/constants', () => ({ API_BASE_URL: 'http://localhost:3000' }));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function ok(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({ ok: true, status, json: () => Promise.resolve(data) });
}
function noContent() {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: () => Promise.resolve(undefined) });
}
function err(status: number, code: string, msg: string) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: msg,
    json: () => Promise.resolve({ code, message: msg }),
  });
}

import {
  listAnomalies,
  detectAnomalies,
  acknowledgeAnomaly,
  listAlerts,
  getAlert,
  acknowledgeAlert,
  resolveAlert,
  getMetrics,
  listRules,
  createRule,
  toggleRule,
  deleteRule,
  listChannels,
  createChannel,
  deleteChannel,
} from '../anomalies';

describe('anomalies', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  // ── Legacy: listAnomalies ─────────────────────────────────────────────

  it('listAnomalies sends GET /v1/anomalies and unwraps .anomalies', async () => {
    ok({ anomalies: [{ id: 'an1' }], total: 1 });
    const result = await listAnomalies();
    expect(result).toEqual([{ id: 'an1' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/anomalies', expect.objectContaining({ method: 'GET' }));
  });

  it('listAnomalies throws on error', async () => {
    err(500, 'INTERNAL', 'Failed');
    await expect(listAnomalies()).rejects.toThrow('Failed');
  });

  // ── Legacy: detectAnomalies ───────────────────────────────────────────

  it('detectAnomalies sends POST /v1/anomalies/detect', async () => {
    const resp = { detectedAt: '2026-04-01', total: 2, anomalies: [] };
    ok(resp);
    const result = await detectAnomalies();
    expect(result).toEqual(resp);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/detect');
    expect(opts.method).toBe('POST');
  });

  // ── Legacy: acknowledgeAnomaly ────────────────────────────────────────

  it('acknowledgeAnomaly sends PATCH /v1/anomalies/:id/acknowledge', async () => {
    ok({ id: 'an1', acknowledged: true });
    await acknowledgeAnomaly('an1');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/an1/acknowledge');
    expect(opts.method).toBe('PATCH');
  });

  // ── Alerts: listAlerts ────────────────────────────────────────────────

  it('listAlerts without params sends GET /v1/anomalies/alerts', async () => {
    ok({ alerts: [{ alertId: 'al1' }], total: 1 });
    const result = await listAlerts();
    expect(result).toEqual([{ alertId: 'al1' }]);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/anomalies/alerts', expect.objectContaining({ method: 'GET' }));
  });

  it('listAlerts with status param', async () => {
    ok({ alerts: [], total: 0 });
    await listAlerts({ status: 'open' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/anomalies/alerts?status=open');
  });

  it('listAlerts with severity param', async () => {
    ok({ alerts: [], total: 0 });
    await listAlerts({ severity: 'critical' });
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/anomalies/alerts?severity=critical');
  });

  it('listAlerts with both params', async () => {
    ok({ alerts: [], total: 0 });
    await listAlerts({ status: 'open', severity: 'high' });
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('status=open');
    expect(url).toContain('severity=high');
  });

  it('listAlerts throws on error', async () => {
    err(500, 'INTERNAL', 'Fail');
    await expect(listAlerts()).rejects.toThrow('Fail');
  });

  // ── Alerts: getAlert ──────────────────────────────────────────────────

  it('getAlert sends GET /v1/anomalies/alerts/:id', async () => {
    ok({ alertId: 'al1' });
    const result = await getAlert('al1');
    expect(result).toEqual({ alertId: 'al1' });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/anomalies/alerts/al1', expect.objectContaining({ method: 'GET' }));
  });

  it('getAlert throws on 404', async () => {
    err(404, 'NOT_FOUND', 'Alert not found');
    await expect(getAlert('missing')).rejects.toThrow('Alert not found');
  });

  // ── Alerts: acknowledgeAlert ──────────────────────────────────────────

  it('acknowledgeAlert sends POST with empty body when no note', async () => {
    ok(undefined);
    await acknowledgeAlert('al1');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/alerts/al1/acknowledge');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({});
  });

  it('acknowledgeAlert sends POST with note', async () => {
    ok(undefined);
    await acknowledgeAlert('al1', 'Investigating');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).toEqual({ note: 'Investigating' });
  });

  // ── Alerts: resolveAlert ──────────────────────────────────────────────

  it('resolveAlert sends POST without note', async () => {
    ok(undefined);
    await resolveAlert('al1');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/alerts/al1/resolve');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({});
  });

  it('resolveAlert sends POST with note', async () => {
    ok(undefined);
    await resolveAlert('al1', 'Fixed');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ note: 'Fixed' });
  });

  // ── Metrics ───────────────────────────────────────────────────────────

  it('getMetrics without params sends GET /v1/anomalies/metrics', async () => {
    const metrics = { totalAlerts: 5, openAlerts: 2 };
    ok(metrics);
    const result = await getMetrics();
    expect(result).toEqual(metrics);
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/anomalies/metrics', expect.objectContaining({ method: 'GET' }));
  });

  it('getMetrics with agentId param', async () => {
    ok({ totalAlerts: 0 });
    await getMetrics('agent-1');
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/anomalies/metrics?agentId=agent-1');
  });

  it('getMetrics with both agentId and window', async () => {
    ok({ totalAlerts: 0 });
    await getMetrics('agent-1', '24h');
    const url = mockFetch.mock.calls[0][0];
    expect(url).toContain('agentId=agent-1');
    expect(url).toContain('window=24h');
  });

  // ── Rules: listRules ──────────────────────────────────────────────────

  it('listRules sends GET /v1/anomalies/rules and unwraps .rules', async () => {
    ok({ rules: [{ ruleId: 'r1', name: 'Rule 1' }] });
    const result = await listRules();
    expect(result).toEqual([{ ruleId: 'r1', name: 'Rule 1' }]);
  });

  it('listRules throws on error', async () => {
    err(500, 'INTERNAL', 'Fail');
    await expect(listRules()).rejects.toThrow('Fail');
  });

  // ── Rules: createRule ─────────────────────────────────────────────────

  it('createRule sends POST /v1/anomalies/rules with body', async () => {
    const data = {
      ruleId: 'r2',
      name: 'New Rule',
      description: 'Desc',
      severity: 'high',
      condition: { threshold: 10 },
    };
    ok({ ...data, builtin: false, enabled: true });
    await createRule(data);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/rules');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  // ── Rules: toggleRule ─────────────────────────────────────────────────

  it('toggleRule sends PATCH /v1/anomalies/rules/:id with enabled', async () => {
    ok({ ruleId: 'r1', enabled: false });
    await toggleRule('r1', false);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/rules/r1');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ enabled: false });
  });

  // ── Rules: deleteRule ─────────────────────────────────────────────────

  it('deleteRule sends DELETE /v1/anomalies/rules/:id', async () => {
    noContent();
    await deleteRule('r1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/anomalies/rules/r1', expect.objectContaining({ method: 'DELETE' }));
  });

  // ── Channels: listChannels ────────────────────────────────────────────

  it('listChannels sends GET /v1/anomalies/channels and unwraps', async () => {
    ok({ channels: [{ id: 'ch1', type: 'slack' }] });
    const result = await listChannels();
    expect(result).toEqual([{ id: 'ch1', type: 'slack' }]);
  });

  // ── Channels: createChannel ───────────────────────────────────────────

  it('createChannel sends POST /v1/anomalies/channels', async () => {
    const data = { type: 'slack', name: 'alerts', config: { url: 'https://hooks.slack.com/x' }, severities: ['critical'] };
    ok({ id: 'ch2', ...data, enabled: true });
    await createChannel(data);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/anomalies/channels');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(data);
  });

  // ── Channels: deleteChannel ───────────────────────────────────────────

  it('deleteChannel sends DELETE /v1/anomalies/channels/:id', async () => {
    noContent();
    await deleteChannel('ch1');
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/v1/anomalies/channels/ch1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('deleteChannel throws on error', async () => {
    err(404, 'NOT_FOUND', 'Channel not found');
    await expect(deleteChannel('missing')).rejects.toThrow('Channel not found');
  });
});
