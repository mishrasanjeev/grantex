import { api } from './client';
import type { Subscription } from './types';

export function getSubscription(): Promise<Subscription> {
  return api.get<Subscription>('/v1/billing/subscription');
}

export function createCheckout(plan: string): Promise<{ url: string }> {
  return api.post<{ url: string }>('/v1/billing/checkout', { plan });
}

export function getPortalUrl(): Promise<{ url: string }> {
  return api.post<{ url: string }>('/v1/billing/portal');
}
