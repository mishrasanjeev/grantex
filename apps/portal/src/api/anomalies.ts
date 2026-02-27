import { api } from './client';
import type { Anomaly } from './types';

export function listAnomalies(): Promise<Anomaly[]> {
  return api.get<Anomaly[]>('/v1/anomalies');
}

export function detectAnomalies(): Promise<{ detected: number }> {
  return api.post<{ detected: number }>('/v1/anomalies/detect');
}

export function acknowledgeAnomaly(id: string): Promise<void> {
  return api.post<void>(`/v1/anomalies/${encodeURIComponent(id)}/acknowledge`);
}
