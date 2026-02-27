import { api } from './client';
import type { Anomaly } from './types';

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
