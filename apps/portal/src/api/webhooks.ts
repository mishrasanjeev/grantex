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

// Webhook deliveries

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  maxAttempts: number;
  url: string;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface ListDeliveriesResponse {
  deliveries: WebhookDelivery[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listDeliveries(
  webhookId: string,
  opts?: { page?: number; pageSize?: number; status?: string },
): Promise<ListDeliveriesResponse> {
  const params = new URLSearchParams();
  if (opts?.page) params.set('page', String(opts.page));
  if (opts?.pageSize) params.set('pageSize', String(opts.pageSize));
  if (opts?.status) params.set('status', opts.status);
  const qs = params.toString();
  const path = `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries${qs ? `?${qs}` : ''}`;
  return api.get<ListDeliveriesResponse>(path);
}
