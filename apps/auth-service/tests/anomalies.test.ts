import { describe, it, expect, beforeAll } from 'vitest';
import { buildTestApp, authHeader, seedAuth, sqlMock } from './helpers.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

// ─── Mock DB rows ─────────────────────────────────────────────────────────────

const RATE_SPIKE_ROW  = { agent_id: 'ag_01', count: '72' };
const HIGH_FAIL_ROW   = { agent_id: 'ag_02', bad_count: '15', total_count: '20' };
const NEW_PRINCIPAL_ROW = { agent_id: 'ag_01', principal_id: 'user_new' };
const OFF_HOURS_ROW   = { agent_id: 'ag_03', count: '18' };

const STORED_ANOMALY = {
  id: 'anm_01',
  type: 'rate_spike',
  severity: 'high',
  agent_id: 'ag_01',
  principal_id: null,
  description: 'Agent ag_01 performed 72 actions in the last hour.',
  metadata: { count: 72 },
  detected_at: '2026-02-26T00:00:00Z',
  acknowledged_at: null,
};

/**
 * Seeds mock slots for POST /v1/anomalies/detect with no anomalies found.
 * SQL calls: 1 auth + 4 detection queries + 1 delete = 6 total.
 */
function seedDetectNoAnomalies() {
  seedAuth();
  sqlMock.mockResolvedValueOnce([]); // rate_spike
  sqlMock.mockResolvedValueOnce([]); // high_failure_rate
  sqlMock.mockResolvedValueOnce([]); // new_principal
  sqlMock.mockResolvedValueOnce([]); // off_hours
  sqlMock.mockResolvedValueOnce([]); // DELETE
}

/**
 * Seeds mock slots for POST /v1/anomalies/detect with one anomaly found.
 * SQL calls: 1 auth + 4 detect + 1 delete + 1 insert = 7 total.
 */
function seedDetectOneAnomaly(
  rateSpike: unknown[] = [],
  highFail: unknown[] = [],
  newPrincipal: unknown[] = [],
  offHours: unknown[] = [],
) {
  seedAuth();
  sqlMock.mockResolvedValueOnce(rateSpike);
  sqlMock.mockResolvedValueOnce(highFail);
  sqlMock.mockResolvedValueOnce(newPrincipal);
  sqlMock.mockResolvedValueOnce(offHours);
  sqlMock.mockResolvedValueOnce([]); // DELETE
  sqlMock.mockResolvedValueOnce([]); // INSERT (one anomaly)
}

// ─── POST /v1/anomalies/detect ────────────────────────────────────────────────

describe('POST /v1/anomalies/detect', () => {
  it('returns empty anomalies when nothing is detected', async () => {
    seedDetectNoAnomalies();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomalies/detect',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; anomalies: unknown[]; detectedAt: string }>();
    expect(body.total).toBe(0);
    expect(body.anomalies).toHaveLength(0);
    expect(body.detectedAt).toBeDefined();
  });

  it('detects rate_spike and returns severity high', async () => {
    seedDetectOneAnomaly([RATE_SPIKE_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomalies/detect',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ total: number; anomalies: Array<{ type: string; severity: string; agentId: string }> }>();
    expect(body.total).toBe(1);
    expect(body.anomalies[0]!.type).toBe('rate_spike');
    expect(body.anomalies[0]!.severity).toBe('high');
    expect(body.anomalies[0]!.agentId).toBe('ag_01');
  });

  it('detects high_failure_rate with correct percentage in description', async () => {
    seedDetectOneAnomaly([], [HIGH_FAIL_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomalies/detect',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ anomalies: Array<{ type: string; severity: string; description: string }> }>();
    expect(body.anomalies[0]!.type).toBe('high_failure_rate');
    expect(body.anomalies[0]!.severity).toBe('medium');
    expect(body.anomalies[0]!.description).toContain('75%'); // 15/20 = 75%
  });

  it('detects new_principal and includes principalId', async () => {
    seedDetectOneAnomaly([], [], [NEW_PRINCIPAL_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomalies/detect',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ anomalies: Array<{ type: string; principalId: string }> }>();
    expect(body.anomalies[0]!.type).toBe('new_principal');
    expect(body.anomalies[0]!.principalId).toBe('user_new');
  });

  it('detects off_hours_activity', async () => {
    seedDetectOneAnomaly([], [], [], [OFF_HOURS_ROW]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomalies/detect',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ anomalies: Array<{ type: string; severity: string }> }>();
    expect(body.anomalies[0]!.type).toBe('off_hours_activity');
    expect(body.anomalies[0]!.severity).toBe('low');
  });
});

// ─── GET /v1/anomalies ────────────────────────────────────────────────────────

describe('GET /v1/anomalies', () => {
  it('returns stored anomalies', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([STORED_ANOMALY]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomalies',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ anomalies: Array<{ id: string; type: string }>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.anomalies[0]!.id).toBe('anm_01');
    expect(body.anomalies[0]!.type).toBe('rate_spike');
  });

  it('returns empty list when no anomalies', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomalies',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ total: number }>().total).toBe(0);
  });
});

// ─── PATCH /v1/anomalies/:id/acknowledge ─────────────────────────────────────

describe('PATCH /v1/anomalies/:id/acknowledge', () => {
  it('acknowledges an anomaly and returns acknowledgedAt', async () => {
    const acked = { ...STORED_ANOMALY, acknowledged_at: '2026-02-26T01:00:00Z' };
    seedAuth();
    sqlMock.mockResolvedValueOnce([acked]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/anomalies/anm_01/acknowledge',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ acknowledgedAt: string }>();
    expect(body.acknowledgedAt).toBe('2026-02-26T01:00:00Z');
  });

  it('returns 404 when anomaly not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/anomalies/anm_missing/acknowledge',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /v1/anomaly/alerts ──────────────────────────────────────────────────

describe('GET /v1/anomaly/alerts', () => {
  it('returns alerts list', async () => {
    const alert = {
      id: 'anm_alert_01',
      type: 'rate_spike',
      severity: 'high',
      status: 'open',
      rule_id: 'AD-001',
      rule_name: 'Velocity spike',
      agent_id: 'ag_01',
      description: 'Velocity spike detected',
      context: { count: 100 },
      metadata: {},
      detected_at: '2026-03-01T00:00:00Z',
      acknowledged_at: null,
      resolved_at: null,
    };
    seedAuth();
    sqlMock.mockResolvedValueOnce([alert]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/alerts',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ alertId: string; status: string }> }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.alertId).toBe('anm_alert_01');
    expect(body.data[0]!.status).toBe('open');
  });
});

// ─── POST /v1/anomaly/alerts/:alertId/resolve ────────────────────────────────

describe('POST /v1/anomaly/alerts/:alertId/resolve', () => {
  it('resolves an alert and returns resolvedAt', async () => {
    const resolved = {
      id: 'anm_alert_01',
      type: 'rate_spike',
      severity: 'high',
      status: 'resolved',
      rule_id: null,
      rule_name: null,
      agent_id: 'ag_01',
      description: 'Velocity spike detected',
      context: {},
      metadata: {},
      detected_at: '2026-03-01T00:00:00Z',
      acknowledged_at: null,
      resolved_at: '2026-03-01T02:00:00Z',
    };
    seedAuth();
    sqlMock.mockResolvedValueOnce([resolved]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/alerts/anm_alert_01/resolve',
      headers: authHeader(),
      payload: { note: 'False positive' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ alertId: string; status: string; resolvedAt: string }>();
    expect(body.alertId).toBe('anm_alert_01');
    expect(body.status).toBe('resolved');
    expect(body.resolvedAt).toBe('2026-03-01T02:00:00Z');
  });

  it('returns 404 when alert not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/alerts/anm_missing/resolve',
      headers: authHeader(),
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /v1/anomaly/metrics ─────────────────────────────────────────────────

describe('GET /v1/anomaly/metrics', () => {
  it('returns metrics for the default 24h window', async () => {
    const metricsRow = {
      total: 5,
      open: 3,
      acknowledged: 1,
      resolved: 1,
      critical: 1,
      high: 2,
      medium: 1,
      low: 1,
    };
    seedAuth();
    sqlMock.mockResolvedValueOnce([metricsRow]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/metrics',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      window: string;
      total: number;
      byStatus: { open: number; acknowledged: number; resolved: number };
      bySeverity: { critical: number; high: number; medium: number; low: number };
    }>();
    expect(body.window).toBe('24h');
    expect(body.total).toBe(5);
    expect(body.byStatus.open).toBe(3);
    expect(body.bySeverity.critical).toBe(1);
  });

  it('rejects invalid window', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/metrics?window=99h',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── POST /v1/anomaly/rules ─────────────────────────────────────────────────

describe('POST /v1/anomaly/rules', () => {
  it('creates a custom rule and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
      payload: {
        ruleId: 'CUSTOM-001',
        name: 'My custom rule',
        description: 'Fires on custom condition',
        condition: { metric: 'grant_rate', threshold: 100, window: '5m' },
        severity: 'high',
        alertChannels: ['ch_01'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      ruleId: string;
      name: string;
      severity: string;
      enabled: boolean;
    }>();
    expect(body.ruleId).toBe('CUSTOM-001');
    expect(body.name).toBe('My custom rule');
    expect(body.severity).toBe('high');
    expect(body.enabled).toBe(true);
  });

  it('returns 400 when ruleId or name is missing', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
      payload: { condition: { metric: 'x' } },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /v1/anomaly/rules ──────────────────────────────────────────────────

describe('GET /v1/anomaly/rules', () => {
  it('returns built-in rules plus custom rules', async () => {
    const customRule = {
      id: 'ar_custom01',
      rule_id: 'CUSTOM-001',
      name: 'My custom rule',
      description: 'Fires on custom condition',
      condition: { metric: 'grant_rate', threshold: 100 },
      severity: 'high',
      alert_channels: ['ch_01'],
      enabled: true,
      created_at: '2026-03-01T00:00:00Z',
    };
    seedAuth();
    sqlMock.mockResolvedValueOnce([customRule]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/rules',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rules: Array<{ ruleId: string; builtIn: boolean }> }>();
    // 10 built-in + 1 custom
    expect(body.rules).toHaveLength(11);
    // First 10 are built-in
    expect(body.rules[0]!.builtIn).toBe(true);
    // Last one is the custom rule
    expect(body.rules[10]!.ruleId).toBe('CUSTOM-001');
    expect(body.rules[10]!.builtIn).toBe(false);
  });
});

// ─── DELETE /v1/anomaly/rules/:ruleId ───────────────────────────────────────

describe('DELETE /v1/anomaly/rules/:ruleId', () => {
  it('deletes a custom rule and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'ar_custom01' }]); // DELETE RETURNING

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/rules/ar_custom01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when rule not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/rules/ar_missing',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /v1/anomaly/channels ──────────────────────────────────────────────

describe('POST /v1/anomaly/channels', () => {
  it('creates a notification channel and returns 201', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]); // INSERT

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
      payload: {
        type: 'slack',
        name: 'Security alerts',
        config: { webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx' },
        severities: ['critical', 'high'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{
      id: string;
      type: string;
      name: string;
      enabled: boolean;
    }>();
    expect(body.type).toBe('slack');
    expect(body.name).toBe('Security alerts');
    expect(body.enabled).toBe(true);
  });

  it('returns 400 for invalid channel type', async () => {
    seedAuth();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
      payload: {
        type: 'sms',
        name: 'Bad channel',
        config: { phone: '+1234567890' },
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ─── GET /v1/anomaly/channels ───────────────────────────────────────────────

describe('GET /v1/anomaly/channels', () => {
  it('returns notification channels', async () => {
    const channel = {
      id: 'ach_01',
      type: 'slack',
      name: 'Security alerts',
      config: { webhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx' },
      severities: ['critical', 'high'],
      enabled: true,
      created_at: '2026-03-01T00:00:00Z',
    };
    seedAuth();
    sqlMock.mockResolvedValueOnce([channel]);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/anomaly/channels',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ channels: Array<{ id: string; type: string }> }>();
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]!.id).toBe('ach_01');
    expect(body.channels[0]!.type).toBe('slack');
  });
});

// ─── DELETE /v1/anomaly/channels/:channelId ─────────────────────────────────

describe('DELETE /v1/anomaly/channels/:channelId', () => {
  it('deletes a channel and returns 204', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ id: 'ach_01' }]); // DELETE RETURNING

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/channels/ach_01',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(204);
  });

  it('returns 404 when channel not found', async () => {
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/anomaly/channels/ach_missing',
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
  });
});
