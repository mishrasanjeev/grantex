import { api } from './client';
import type { Anomaly } from './types';

// ── Alert types ─────────────────────────────────────────────────────────────

export interface AnomalyAlert {
  alertId: string;
  ruleId: string;
  ruleName: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'acknowledged' | 'resolved';
  agentId: string | null;
  detectedAt: string;
  description: string;
  context: Record<string, unknown>;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

export interface AnomalyRule {
  ruleId: string;
  name: string;
  description: string;
  severity: string;
  builtin: boolean;
  enabled: boolean;
}

export interface AnomalyChannel {
  id: string;
  type: string;
  name: string;
  severities: string[];
  enabled: boolean;
}

export interface AnomalyMetrics {
  totalAlerts: number;
  openAlerts: number;
  bySeverity: Record<string, number>;
  byRule: Record<string, number>;
  recentActivity: { date: string; count: number }[];
}

// ── Legacy anomaly functions ────────────────────────────────────────────────

export async function listAnomalies(): Promise<Anomaly[]> {
  const res = await api.get<{ anomalies: Anomaly[]; total: number }>('/v1/anomalies');
  return res.anomalies;
}

export function detectAnomalies(): Promise<{ detectedAt: string; total: number; anomalies: Anomaly[] }> {
  return api.post<{ detectedAt: string; total: number; anomalies: Anomaly[] }>('/v1/anomalies/detect');
}

export function acknowledgeAnomaly(id: string): Promise<Anomaly> {
  return api.patch<Anomaly>(`/v1/anomalies/${encodeURIComponent(id)}/acknowledge`);
}

// ── Alert functions ─────────────────────────────────────────────────────────

export async function listAlerts(params?: {
  status?: string;
  severity?: string;
}): Promise<AnomalyAlert[]> {
  const query = new URLSearchParams();
  if (params?.status) query.set('status', params.status);
  if (params?.severity) query.set('severity', params.severity);
  const qs = query.toString();
  const res = await api.get<{ alerts: AnomalyAlert[]; total: number }>(
    `/v1/anomalies/alerts${qs ? `?${qs}` : ''}`,
  );
  return res.alerts;
}

export async function getAlert(alertId: string): Promise<AnomalyAlert> {
  return api.get<AnomalyAlert>(`/v1/anomalies/alerts/${encodeURIComponent(alertId)}`);
}

export async function acknowledgeAlert(alertId: string, note?: string): Promise<void> {
  await api.post(`/v1/anomalies/alerts/${encodeURIComponent(alertId)}/acknowledge`, {
    ...(note !== undefined ? { note } : {}),
  });
}

export async function resolveAlert(alertId: string, note?: string): Promise<void> {
  await api.post(`/v1/anomalies/alerts/${encodeURIComponent(alertId)}/resolve`, {
    ...(note !== undefined ? { note } : {}),
  });
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export async function getMetrics(agentId?: string, window?: string): Promise<AnomalyMetrics> {
  const query = new URLSearchParams();
  if (agentId) query.set('agentId', agentId);
  if (window) query.set('window', window);
  const qs = query.toString();
  return api.get<AnomalyMetrics>(`/v1/anomalies/metrics${qs ? `?${qs}` : ''}`);
}

// ── Rule functions ──────────────────────────────────────────────────────────

export async function listRules(): Promise<AnomalyRule[]> {
  const res = await api.get<{ rules: AnomalyRule[] }>('/v1/anomalies/rules');
  return res.rules;
}

export async function createRule(params: {
  ruleId: string;
  name: string;
  description: string;
  severity: string;
  condition: {
    agentIds?: string[];
    scopes?: string[];
    timeWindow?: string;
    threshold?: number;
  };
  channels?: string[];
}): Promise<AnomalyRule> {
  return api.post<AnomalyRule>('/v1/anomalies/rules', params);
}

export async function toggleRule(ruleId: string, enabled: boolean): Promise<AnomalyRule> {
  return api.patch<AnomalyRule>(`/v1/anomalies/rules/${encodeURIComponent(ruleId)}`, { enabled });
}

export async function deleteRule(ruleId: string): Promise<void> {
  await api.del(`/v1/anomalies/rules/${encodeURIComponent(ruleId)}`);
}

// ── Channel functions ───────────────────────────────────────────────────────

export async function listChannels(): Promise<AnomalyChannel[]> {
  const res = await api.get<{ channels: AnomalyChannel[] }>('/v1/anomalies/channels');
  return res.channels;
}

export async function createChannel(params: {
  type: string;
  name: string;
  config: Record<string, string>;
  severities: string[];
}): Promise<AnomalyChannel> {
  return api.post<AnomalyChannel>('/v1/anomalies/channels', params);
}

export async function deleteChannel(channelId: string): Promise<void> {
  await api.del(`/v1/anomalies/channels/${encodeURIComponent(channelId)}`);
}
