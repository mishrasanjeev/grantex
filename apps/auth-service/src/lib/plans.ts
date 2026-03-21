export type PlanName = 'free' | 'pro' | 'enterprise';

export interface PlanLimits {
  agents: number;
  webhooks: number;
  grants: number;
  auditEntries: number;
  policies: number;
  tokenExchangesPerMonth: number;
  authorizationsPerMonth: number;
}

export const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  free:       { agents: 200,      webhooks: 5,         grants: 500,       auditEntries: 10_000,   policies: 10,   tokenExchangesPerMonth: 10_000,   authorizationsPerMonth: 10_000   },
  pro:        { agents: 1_000,    webhooks: 50,        grants: 10_000,    auditEntries: 500_000,  policies: 200,  tokenExchangesPerMonth: 1_000_000, authorizationsPerMonth: 1_000_000 },
  enterprise: { agents: Infinity, webhooks: Infinity,  grants: Infinity,  auditEntries: Infinity, policies: Infinity, tokenExchangesPerMonth: Infinity, authorizationsPerMonth: Infinity },
};

export const PLAN_DISPLAY: Record<PlanName, string> = {
  free:       'Free',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

export function isPlanName(s: string): s is PlanName {
  return s === 'free' || s === 'pro' || s === 'enterprise';
}
