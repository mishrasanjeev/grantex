import { api } from './client';
import type { Agent, CreateAgentRequest } from './types';

export async function listAgents(): Promise<Agent[]> {
  const res = await api.get<{ agents: Agent[] }>('/v1/agents');
  return res.agents;
}

export function getAgent(id: string): Promise<Agent> {
  return api.get<Agent>(`/v1/agents/${encodeURIComponent(id)}`);
}

export function createAgent(data: CreateAgentRequest): Promise<Agent> {
  return api.post<Agent>('/v1/agents', data);
}

export function updateAgent(id: string, data: Partial<CreateAgentRequest> & { status?: string }): Promise<Agent> {
  return api.patch<Agent>(`/v1/agents/${encodeURIComponent(id)}`, data);
}

export function deleteAgent(id: string): Promise<void> {
  return api.del(`/v1/agents/${encodeURIComponent(id)}`);
}
