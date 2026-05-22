export const COMMERCE_PUBLIC_DISCOVERY_ENABLED_ENV = 'COMMERCE_PUBLIC_DISCOVERY_ENABLED';
export const COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST_ENV = 'COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST';

const EXPLICIT_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

export function isExplicitSafeTrue(value: string | undefined): boolean {
  return EXPLICIT_TRUE_VALUES.has((value ?? '').trim().toLowerCase());
}

export function isCommercePublicDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isExplicitSafeTrue(env[COMMERCE_PUBLIC_DISCOVERY_ENABLED_ENV]);
}

export function commercePublicDiscoveryMerchantAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const raw = env[COMMERCE_PUBLIC_DISCOVERY_MERCHANT_ALLOWLIST_ENV] ?? '';
  for (const item of raw.split(',')) {
    const merchantId = item.trim();
    if (merchantId.length > 0) seen.add(merchantId);
  }
  return [...seen];
}
