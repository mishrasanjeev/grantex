export type PlanName = 'free' | 'pro' | 'enterprise';

export interface PlanLimits {
  agents: number;
  webhooks: number;
}

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free:       { agents: 3,        webhooks: 1  },
  pro:        { agents: 25,       webhooks: 10 },
  enterprise: { agents: Infinity, webhooks: Infinity },
};

export const PLAN_DISPLAY: Record<PlanName, string> = {
  free:       'Free',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

export function isPlanName(s: string): s is PlanName {
  return s === 'free' || s === 'pro' || s === 'enterprise';
}
