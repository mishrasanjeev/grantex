import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ─── Mock data ───────────────────────────────────────────────────────────────

const ALERT_ROW = {
  id: 'anm_ALERT01',
  type: 'rate_spike',
  severity: 'high',
  status: 'open',
  rule_id: 'AD-001',
  rule_name: 'Velocity spike',
  agent_id: 'ag_01',
  description: 'Agent ag_01 performed 72 actions in the last hour.',
  context: { count: 72 },
  metadata: { count: 72 },
  detected_at: '2026-04-01T00:00:00Z',
  acknowledged_at: null,
  resolved_at: null,
};

const ALERT_ROW_CRITICAL = {
  ...ALERT_ROW,
  id: 'anm_ALERT02',
  severity: 'critical',
  rule_id: 'AD-002',
  rule_name: 'Scope escalation attempt',
};

const CUSTOM_RULE_ROW = {
  id: 'arule_01',
  rule_id: 'CUSTOM-001',
  name: 'My custom rule',
  description: 'Custom detection rule',
  condition: { threshold: 100, timeWindow: '5m' },
  severity: 'high',
  alert_channels: ['achan_01'],
  enabled: true,
  created_at: '2026-04-01T00:00:00Z',
};

const CHANNEL_ROW = {
  id: 'achan_01',
  type: 'slack',
  name: 'Security alerts',
  config: { webhookUrl: 'https://hooks.slack.com/test' },
  severities: ['critical', 'high'],
  enabled: true,
  created_at: '2026-04-01T00:00:00Z',
};

// ─── GET /v1/anomaly/alerts ─────────────────────────────────────────────────

describe('GET /v1/anomaly/alerts', () => {
  it('returns alerts list', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([ALERT_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/alerts',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ alertId: string; severity: string; status: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.alertId).toBe('anm_ALERT01');
    expect(body.data[0]!.severity).toBe('high');
    expect(body.data[0]!.status).toBe('open');
  });

  it('filters by status', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ ...ALERT_ROW, status: 'acknowledged' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/alerts?status=acknowledged',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ status: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.status).toBe('acknowledged');
  });

  it('filters by severity', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([ALERT_ROW_CRITICAL]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/alerts?severity=critical',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ severity: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.severity).toBe('critical');
  });
});

// ─── POST /v1/anomaly/alerts/:alertId/acknowledge ───────────────────────────

describe('POST /v1/anomaly/alerts/:alertId/acknowledge', () => {
  it('sets status to acknowledged', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...ALERT_ROW,
      status: 'acknowledged',
      acknowledged_at: '2026-04-01T01:00:00Z',
      resolution_note: 'Looking into it',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/alerts/anm_ALERT01/acknowledge',
      headers: authHeader(),
      payload: { note: 'Looking into it' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; acknowledgedAt: string }>();
    expect(body.status).toBe('acknowledged');
    expect(body.acknowledgedAt).toBe('2026-04-01T01:00:00Z');
  });

  it('returns 404 for unknown alert', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/alerts/anm_MISSING/acknowledge',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ─── POST /v1/anomaly/alerts/:alertId/resolve ───────────────────────────────

describe('POST /v1/anomaly/alerts/:alertId/resolve', () => {
  it('sets status to resolved and resolved_at', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      ...ALERT_ROW,
      status: 'resolved',
      resolved_at: '2026-04-01T02:00:00Z',
      resolution_note: 'False positive',
    }]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/alerts/anm_ALERT01/resolve',
      headers: authHeader(),
      payload: { note: 'False positive' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; resolvedAt: string }>();
    expect(body.status).toBe('resolved');
    expect(body.resolvedAt).toBe('2026-04-01T02:00:00Z');
  });

  it('returns 404 for unknown alert', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/alerts/anm_MISSING/resolve',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ─── GET /v1/anomaly/metrics ────────────────────────────────────────────────

describe('GET /v1/anomaly/metrics', () => {
  it('returns aggregated metrics', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{
      total: 10,
      open: 5,
      acknowledged: 3,
      resolved: 2,
      critical: 1,
      high: 4,
      medium: 3,
      low: 2,
    }]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/metrics',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.window).toBe('24h');
    expect(body.total).toBe(10);
    expect(body.byStatus.open).toBe(5);
    expect(body.byStatus.acknowledged).toBe(3);
    expect(body.byStatus.resolved).toBe(2);
    expect(body.bySeverity.critical).toBe(1);
    expect(body.bySeverity.high).toBe(4);
  });
});

// ─── POST /v1/anomaly/rules ─────────────────────────────────────────────────

describe('POST /v1/anomaly/rules', () => {
  it('creates a custom rule', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
      payload: {
        ruleId: 'CUSTOM-001',
        name: 'My custom rule',
        description: 'Custom detection rule',
        condition: { threshold: 100, timeWindow: '5m' },
        severity: 'high',
        alertChannels: ['achan_01'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^arule_/);
    expect(body.ruleId).toBe('CUSTOM-001');
    expect(body.name).toBe('My custom rule');
    expect(body.severity).toBe('high');
    expect(body.enabled).toBe(true);
  });

  it('rejects missing name (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
      payload: {
        ruleId: 'CUSTOM-002',
        condition: { threshold: 10 },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects missing condition (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
      payload: {
        ruleId: 'CUSTOM-003',
        name: 'No condition',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

// ─── GET /v1/anomaly/rules ──────────────────────────────────────────────────

describe('GET /v1/anomaly/rules', () => {
  it('lists built-in + custom rules', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([CUSTOM_RULE_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rules: Array<{ ruleId: string; builtIn: boolean }> }>();
    // 10 built-in + 1 custom
    expect(body.rules).toHaveLength(11);

    // Built-in rules always present
    const builtInRules = body.rules.filter((r) => r.builtIn);
    expect(builtInRules).toHaveLength(10);
    expect(builtInRules.map((r) => r.ruleId)).toContain('AD-001');
    expect(builtInRules.map((r) => r.ruleId)).toContain('AD-010');

    // Custom rule present
    const customRules = body.rules.filter((r) => !r.builtIn);
    expect(customRules).toHaveLength(1);
    expect(customRules[0]!.ruleId).toBe('CUSTOM-001');
  });

  it('built-in rules always present even with no custom rules', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // No custom rules

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rules: Array<{ ruleId: string; builtIn: boolean }> }>();
    expect(body.rules).toHaveLength(10);
    expect(body.rules.every((r) => r.builtIn)).toBe(true);
  });
});

// ─── DELETE /v1/anomaly/rules/:ruleId ───────────────────────────────────────

describe('DELETE /v1/anomaly/rules/:ruleId', () => {
  it('deletes a custom rule', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'arule_01' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/rules/arule_01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown rule', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/rules/arule_MISSING',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});

// ─── POST /v1/anomaly/channels ──────────────────────────────────────────────

describe('POST /v1/anomaly/channels', () => {
  it('creates a notification channel', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
      payload: {
        type: 'slack',
        name: 'Security alerts',
        config: { webhookUrl: 'https://hooks.slack.com/test' },
        severities: ['critical', 'high'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^achan_/);
    expect(body.type).toBe('slack');
    expect(body.name).toBe('Security alerts');
    expect(body.enabled).toBe(true);
  });

  it('rejects invalid type (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
      payload: {
        type: 'sms',
        name: 'SMS channel',
        config: { phone: '+1234567890' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });

  it('rejects missing name (400)', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
      payload: {
        type: 'webhook',
        config: { webhookUrl: 'https://example.com/hook' },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('BAD_REQUEST');
  });
});

// ─── GET /v1/anomaly/channels ───────────────────────────────────────────────

describe('GET /v1/anomaly/channels', () => {
  it('lists notification channels', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([CHANNEL_ROW]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ channels: Array<{ id: string; type: string }> }>();
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]!.id).toBe('achan_01');
    expect(body.channels[0]!.type).toBe('slack');
  });

  it('returns empty list when no channels', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().channels).toEqual([]);
  });
});

// ─── DELETE /v1/anomaly/channels/:channelId ─────────────────────────────────

describe('DELETE /v1/anomaly/channels/:channelId', () => {
  it('deletes a notification channel', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'achan_01' }]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/channels/achan_01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown channel', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/channels/achan_MISSING',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('NOT_FOUND');
  });
});
