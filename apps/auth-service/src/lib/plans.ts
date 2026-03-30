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
  free:       { agents: 500,      webhooks: 30,        grants: 1_000,     auditEntries: 20_000,   policies: 50,   tokenExchangesPerMonth: 50_000,   authorizationsPerMonth: 50_000   },
  pro:        { agents: 5_000,    webhooks: 200,       grants: 50_000,    auditEntries: 1_000_000, policies: 500,  tokenExchangesPerMonth: 5_000_000, authorizationsPerMonth: 5_000_000 },
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
