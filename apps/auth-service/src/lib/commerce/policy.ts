export const COMMERCE_POLICY_SCOPES = [
  'commerce:catalog.read',
  'commerce:inventory.read',
  'commerce:checkout.create',
  'commerce:payment.initiate',
  'commerce:payment.status.read',
] as const;

export type CommercePolicyScope = typeof COMMERCE_POLICY_SCOPES[number];

export interface CommercePolicyRules {
  amount_cap: {
    max_amount_minor_units: number;
    currency: string;
  };
  scope_allowlist: CommercePolicyScope[];
  emergency_disable: boolean;
  checkout_passport_max_ttl_seconds: number;
  browse_passport_max_ttl_seconds: number;
  stale_price_max_age_seconds: number;
  allow_unknown_inventory_checkout: boolean;
}

export type CommercePolicyDecision = 'allow' | 'deny' | 'requires_user_consent';

export interface PolicyRuleEvaluationInput {
  actionScope: CommercePolicyScope;
  amountMinorUnits: number | null;
  currency: string | null;
  passportScopes: string[];
  passportMaxAmount: number | null;
  passportCurrency: string | null;
}

export interface PolicyRuleEvaluationResult {
  decision: CommercePolicyDecision;
  reason: string;
}

export type PolicyRulesValidation =
  | { ok: true; rules: CommercePolicyRules }
  | { ok: false; fieldErrors: Record<string, string> };

const TOP_LEVEL_KEYS = new Set([
  'amount_cap',
  'scope_allowlist',
  'emergency_disable',
  'checkout_passport_max_ttl_seconds',
  'browse_passport_max_ttl_seconds',
  'stale_price_max_age_seconds',
  'allow_unknown_inventory_checkout',
]);

const AMOUNT_CAP_KEYS = new Set(['max_amount_minor_units', 'currency']);
const SCOPE_SET = new Set<string>(COMMERCE_POLICY_SCOPES);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asSafeInteger(v: unknown): number | null {
  if (!Number.isSafeInteger(v)) return null;
  return v as number;
}

function requireInteger(
  fieldErrors: Record<string, string>,
  path: string,
  value: unknown,
  min: number,
  max?: number,
): number {
  const n = asSafeInteger(value);
  if (n === null || n < min || (max !== undefined && n > max)) {
    fieldErrors[path] = max === undefined
      ? `must be an integer >= ${min}`
      : `must be an integer between ${min} and ${max}`;
    return min;
  }
  return n;
}

function isCurrency(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Z]{3}$/.test(v);
}

export function isCommercePolicyScope(v: unknown): v is CommercePolicyScope {
  return typeof v === 'string' && SCOPE_SET.has(v);
}

export function validateCommercePolicyRules(input: unknown): PolicyRulesValidation {
  const fieldErrors: Record<string, string> = {};
  if (!isPlainObject(input)) {
    return { ok: false, fieldErrors: { rules: 'required object' } };
  }

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fieldErrors[`rules.${key}`] = 'unknown rule key';
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in input)) {
      fieldErrors[`rules.${key}`] = 'required';
    }
  }

  const amountCapRaw = input['amount_cap'];
  let maxAmount = 0;
  let currency = 'INR';
  if (!isPlainObject(amountCapRaw)) {
    fieldErrors['rules.amount_cap'] = 'required object';
  } else {
    for (const key of Object.keys(amountCapRaw)) {
      if (!AMOUNT_CAP_KEYS.has(key)) {
        fieldErrors[`rules.amount_cap.${key}`] = 'unknown amount_cap key';
      }
    }
    maxAmount = requireInteger(
      fieldErrors,
      'rules.amount_cap.max_amount_minor_units',
      amountCapRaw['max_amount_minor_units'],
      0,
    );
    if (!isCurrency(amountCapRaw['currency'])) {
      fieldErrors['rules.amount_cap.currency'] = 'must be an ISO 4217 uppercase currency code';
    } else {
      currency = amountCapRaw['currency'];
    }
  }

  const scopeAllowlistRaw = input['scope_allowlist'];
  const scopeAllowlist: CommercePolicyScope[] = [];
  if (!Array.isArray(scopeAllowlistRaw) || scopeAllowlistRaw.length === 0) {
    fieldErrors['rules.scope_allowlist'] = 'must be a non-empty string array';
  } else {
    const seen = new Set<string>();
    scopeAllowlistRaw.forEach((scope, i) => {
      const path = `rules.scope_allowlist[${i}]`;
      if (!isCommercePolicyScope(scope)) {
        fieldErrors[path] = 'must be a supported commerce scope';
        return;
      }
      if (seen.has(scope)) {
        fieldErrors[path] = 'duplicate scope';
        return;
      }
      seen.add(scope);
      scopeAllowlist.push(scope);
    });
  }

  if (typeof input['emergency_disable'] !== 'boolean') {
    fieldErrors['rules.emergency_disable'] = 'required boolean';
  }
  const checkoutTtl = requireInteger(
    fieldErrors,
    'rules.checkout_passport_max_ttl_seconds',
    input['checkout_passport_max_ttl_seconds'],
    1,
    600,
  );
  const browseTtl = requireInteger(
    fieldErrors,
    'rules.browse_passport_max_ttl_seconds',
    input['browse_passport_max_ttl_seconds'],
    1,
    3600,
  );
  const stalePriceMaxAge = requireInteger(
    fieldErrors,
    'rules.stale_price_max_age_seconds',
    input['stale_price_max_age_seconds'],
    0,
  );
  if (typeof input['allow_unknown_inventory_checkout'] !== 'boolean') {
    fieldErrors['rules.allow_unknown_inventory_checkout'] = 'required boolean';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }

  return {
    ok: true,
    rules: {
      amount_cap: {
        max_amount_minor_units: maxAmount,
        currency,
      },
      scope_allowlist: scopeAllowlist,
      emergency_disable: input['emergency_disable'] as boolean,
      checkout_passport_max_ttl_seconds: checkoutTtl,
      browse_passport_max_ttl_seconds: browseTtl,
      stale_price_max_age_seconds: stalePriceMaxAge,
      allow_unknown_inventory_checkout: input['allow_unknown_inventory_checkout'] as boolean,
    },
  };
}

export function assertPolicyCurrencyConsistency(
  rules: CommercePolicyRules,
  merchantDefaultCurrency: string,
): Record<string, string> | null {
  if (rules.amount_cap.currency !== merchantDefaultCurrency) {
    return {
      'rules.amount_cap.currency':
        `must match merchant default_currency (${merchantDefaultCurrency}) before activation`,
    };
  }
  return null;
}

export function evaluateCommercePolicyRules(
  rules: CommercePolicyRules,
  input: PolicyRuleEvaluationInput,
): PolicyRuleEvaluationResult {
  if (rules.emergency_disable) {
    return { decision: 'deny', reason: 'emergency_disabled' };
  }
  if (!rules.scope_allowlist.includes(input.actionScope)) {
    return { decision: 'deny', reason: 'scope_not_allowed' };
  }
  if (!input.passportScopes.includes(input.actionScope)) {
    return { decision: 'requires_user_consent', reason: 'passport_scope_missing' };
  }

  if (input.amountMinorUnits !== null || input.currency !== null) {
    if (input.amountMinorUnits === null || input.currency === null) {
      return { decision: 'deny', reason: 'amount_context_incomplete' };
    }
    if (input.currency !== rules.amount_cap.currency) {
      return { decision: 'deny', reason: 'currency_mismatch' };
    }
    if (input.amountMinorUnits > rules.amount_cap.max_amount_minor_units) {
      return { decision: 'deny', reason: 'amount_cap_exceeded' };
    }
    if (input.passportCurrency !== null && input.passportCurrency !== input.currency) {
      return { decision: 'requires_user_consent', reason: 'passport_currency_mismatch' };
    }
    if (input.passportMaxAmount === null || input.amountMinorUnits > input.passportMaxAmount) {
      return { decision: 'requires_user_consent', reason: 'passport_amount_exceeded' };
    }
  }

  return { decision: 'allow', reason: 'policy_allowed' };
}

