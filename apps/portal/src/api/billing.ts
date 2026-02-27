import { api } from './client';
import type { Subscription } from './types';

export function getSubscription(): Promise<Subscription> {
  return api.get<Subscription>('/v1/billing/subscription');
}

export function createCheckout(plan: string): Promise<{ checkoutUrl: string }> {
  return api.post<{ checkoutUrl: string }>('/v1/billing/checkout', {
    plan,
    successUrl: `${window.location.origin}/dashboard/billing?success=true`,
    cancelUrl: `${window.location.origin}/dashboard/billing`,
  });
}

export function getPortalUrl(): Promise<{ portalUrl: string }> {
  return api.post<{ portalUrl: string }>('/v1/billing/portal', {
    returnUrl: `${window.location.origin}/dashboard/billing`,
  });
}
