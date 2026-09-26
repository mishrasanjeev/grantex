import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { authHeader, buildTestApp, seedAuth, sqlMock } from './helpers.js';
import { emitEvent } from '../src/lib/events.js';

let app: FastifyInstance;
beforeAll(async () => { app = await buildTestApp(); });
afterEach(() => vi.unstubAllEnvs());

describe('account irregularity response policy', () => {
  it('is unavailable without its rollout flag', async () => {
    seedAuth();
    const result = await app.inject({ method: 'GET', url: '/v1/irregularities/response-policy', headers: authHeader() });
    expect(result.statusCode).toBe(404);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('requires developer authentication', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    const result = await app.inject({ method: 'PATCH', url: '/v1/irregularities/response-policy',
      payload: { mode: 'alert_only' } });
    expect(result.statusCode).toBe(401);
  });

  it('reads policy only from the authenticated account', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ irregularity_response_mode: 'revoke_agent_grants' }]);
    const result = await app.inject({ method: 'GET', url: '/v1/irregularities/response-policy', headers: authHeader() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ mode: 'revoke_agent_grants' });
    expect(sqlMock.mock.calls[1]?.[1]).toBe('dev_TEST');
  });

  it('rejects invalid policy values and fails closed if the stored policy cannot be read', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    const invalid = await app.inject({ method: 'PATCH', url: '/v1/irregularities/response-policy',
      headers: authHeader(), payload: { mode: 'none' } });
    expect(invalid.statusCode).toBe(400);
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const missing = await app.inject({ method: 'GET', url: '/v1/irregularities/response-policy', headers: authHeader() });
    expect(missing.statusCode).toBe(503);
  });

  it('updates only the authenticated account and records a durable transition', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ irregularity_response_mode: 'revoke_agent_grants' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'PATCH', url: '/v1/irregularities/response-policy',
      headers: authHeader(), payload: { mode: 'alert_only' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ mode: 'alert_only' });
    const updateQuery = (sqlMock.mock.calls[2]?.[0] as TemplateStringsArray).join(' ');
    expect(updateQuery).toContain('WHERE id =');
    expect(sqlMock.mock.calls[2]?.[2]).toBe('dev_TEST');
    const historyQuery = (sqlMock.mock.calls[3]?.[0] as TemplateStringsArray).join(' ');
    expect(historyQuery).toContain('INSERT INTO irregularity_policy_changes');
    expect(emitEvent).toHaveBeenCalledWith('dev_TEST', 'irregularity.policy.updated', {
      previousMode: 'revoke_agent_grants', mode: 'alert_only',
    });
  });

  it('does not write a history row for an unchanged policy', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ irregularity_response_mode: 'alert_only' }]);
    const result = await app.inject({ method: 'PATCH', url: '/v1/irregularities/response-policy',
      headers: authHeader(), payload: { mode: 'alert_only' } });
    expect(result.statusCode).toBe(200);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });

  it('returns the committed policy even if event delivery fails', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    vi.mocked(emitEvent).mockRejectedValueOnce(new Error('queue unavailable'));
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ irregularity_response_mode: 'revoke_agent_grants' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'PATCH', url: '/v1/irregularities/response-policy',
      headers: authHeader(), payload: { mode: 'alert_only' } });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ mode: 'alert_only' });
  });

  it('keeps alerts but never touches grants in alert-only mode', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ irregularity_response_mode: 'alert_only' }]);
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_TEST', count: '75' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'POST', url: '/v1/anomalies/detect', headers: authHeader() });
    expect(result.statusCode).toBe(200);
    expect(result.json().total).toBe(1);
    expect(result.json().responseMode).toBe('alert_only');
    expect(result.json().autoRevokedGrants).toBe(0);
    expect(emitEvent).toHaveBeenCalledWith('dev_TEST', 'anomaly.detected', expect.objectContaining({
      severity: 'high', agentId: 'ag_TEST',
    }));
    const allQueries = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join(' ');
    expect(allQueries).not.toContain('UPDATE grants SET status');
  });

  it('preserves agent-grant revocation when the account selects that policy', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([{ irregularity_response_mode: 'revoke_agent_grants' }]);
    sqlMock.mockResolvedValueOnce([{ agent_id: 'ag_TEST', count: '75' }]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([{ id: 'grnt_TEST' }]);
    const result = await app.inject({ method: 'POST', url: '/v1/anomalies/detect', headers: authHeader() });
    expect(result.statusCode).toBe(200);
    expect(result.json().autoRevokedGrants).toBe(1);
    expect(result.json().responseMode).toBe('revoke_agent_grants');
    const allQueries = sqlMock.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' ')).join(' ');
    expect(allQueries).toContain('UPDATE grants SET status');
    expect(allQueries).toContain("irregularity_response_mode = 'revoke_agent_grants'");
  });

  it('does not run detection when the stored policy is missing', async () => {
    vi.stubEnv('IRREGULARITY_RESPONSE_POLICY_ENABLED', 'true');
    seedAuth();
    sqlMock.mockResolvedValueOnce([]);
    const result = await app.inject({ method: 'POST', url: '/v1/anomalies/detect', headers: authHeader() });
    expect(result.statusCode).toBe(503);
    expect(sqlMock).toHaveBeenCalledTimes(2);
  });
});
