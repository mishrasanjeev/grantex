import { api } from './client';

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

export async function listWebhooks(): Promise<WebhookEndpoint[]> {
  const res = await api.get<{ webhooks: WebhookEndpoint[] }>('/v1/webhooks');
  return res.webhooks;
}

export function createWebhook(data: {
  url: string;
  events: string[];
}): Promise<WebhookEndpointWithSecret> {
  return api.post<WebhookEndpointWithSecret>('/v1/webhooks', data);
}

export function deleteWebhook(id: string): Promise<void> {
  return api.del(`/v1/webhooks/${encodeURIComponent(id)}`);
}
