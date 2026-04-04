import { api } from './client';

export interface EnforceLogEntry {
  id: string;
  timestamp: string;
  agentId: string;
  agentDid: string;
  connector: string;
  tool: string;
  permission: string;
  result: 'allowed' | 'denied';
  reason: string;
  scopes: string[];
  grantId: string;
}

export interface EnforceLogResponse {
  entries: EnforceLogEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listEnforceLogs(params?: {
  result?: string;
  connector?: string;
  agentId?: string;
  page?: number;
  pageSize?: number;
}): Promise<EnforceLogResponse> {
  const q = new URLSearchParams();
  if (params?.result) q.set('result', params.result);
  if (params?.connector) q.set('connector', params.connector);
  if (params?.agentId) q.set('agentId', params.agentId);
  if (params?.page) q.set('page', String(params.page));
  if (params?.pageSize) q.set('pageSize', String(params.pageSize));
  const qs = q.toString();
  return api.get<EnforceLogResponse>(`/v1/enforce-log${qs ? `?${qs}` : ''}`);
}
