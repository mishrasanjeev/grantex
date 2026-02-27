import { api } from './client';
import type { Policy, CreatePolicyRequest } from './types';

export function listPolicies(): Promise<Policy[]> {
  return api.get<Policy[]>('/v1/policies');
}

export function getPolicy(id: string): Promise<Policy> {
  return api.get<Policy>(`/v1/policies/${encodeURIComponent(id)}`);
}

export function createPolicy(data: CreatePolicyRequest): Promise<Policy> {
  return api.post<Policy>('/v1/policies', data);
}

export function updatePolicy(id: string, data: Partial<CreatePolicyRequest>): Promise<Policy> {
  return api.patch<Policy>(`/v1/policies/${encodeURIComponent(id)}`, data);
}

export function deletePolicy(id: string): Promise<void> {
  return api.del(`/v1/policies/${encodeURIComponent(id)}`);
}
