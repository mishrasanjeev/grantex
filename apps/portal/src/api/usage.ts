import { api } from './client';
import type { UsageResponse, UsageHistoryResponse } from './types';

export function getUsage(): Promise<UsageResponse> {
  return api.get<UsageResponse>('/v1/usage');
}

export function getUsageHistory(days: number): Promise<UsageHistoryResponse> {
  return api.get<UsageHistoryResponse>(`/v1/usage/history?days=${days}`);
}
