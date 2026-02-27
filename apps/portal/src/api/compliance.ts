import { api } from './client';
import type { ComplianceSummary } from './types';

export function getComplianceSummary(): Promise<ComplianceSummary> {
  return api.get<ComplianceSummary>('/v1/compliance/summary');
}

export function exportComplianceReport(framework: string): Promise<Blob> {
  return api.get<Blob>(`/v1/compliance/export?framework=${encodeURIComponent(framework)}`);
}
