import { api } from './client';

export interface EventRecord {
  id: string;
  type: string;
  developerId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function listRecentEvents(): Promise<EventRecord[]> {
  const res = await api.get<{ events: EventRecord[] }>('/v1/events/stream');
  return res.events ?? [];
}
