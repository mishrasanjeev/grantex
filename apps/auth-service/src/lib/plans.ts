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
  free:       { agents: 3,        webhooks: 1,        grants: 50,       auditEntries: 1_000,   policies: 5,   tokenExchangesPerMonth: 1_000,   authorizationsPerMonth: 1_000   },
  pro:        { agents: 25,       webhooks: 10,       grants: 500,      auditEntries: 50_000,  policies: 50,  tokenExchangesPerMonth: 100_000, authorizationsPerMonth: 100_000 },
  enterprise: { agents: Infinity, webhooks: Infinity, grants: Infinity, auditEntries: Infinity, policies: Infinity, tokenExchangesPerMonth: Infinity, authorizationsPerMonth: Infinity },
};

export const PLAN_DISPLAY: Record<PlanName, string> = {
  free:       'Free',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

export function isPlanName(s: string): s is PlanName {
  return s === 'free' || s === 'pro' || s === 'enterprise';
}
