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
