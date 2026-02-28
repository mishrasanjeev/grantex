export type PlanName = 'free' | 'pro' | 'enterprise';

export interface PlanLimits {
  agents: number;
  webhooks: number;
  grants: number;
  auditEntries: number;
  policies: number;
}

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free:       { agents: 3,        webhooks: 1,        grants: 50,       auditEntries: 1_000,   policies: 5   },
  pro:        { agents: 25,       webhooks: 10,       grants: 500,      auditEntries: 50_000,  policies: 50  },
  enterprise: { agents: Infinity, webhooks: Infinity, grants: Infinity, auditEntries: Infinity, policies: Infinity },
};

export const PLAN_DISPLAY: Record<PlanName, string> = {
  free:       'Free',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

export function isPlanName(s: string): s is PlanName {
  return s === 'free' || s === 'pro' || s === 'enterprise';
}
