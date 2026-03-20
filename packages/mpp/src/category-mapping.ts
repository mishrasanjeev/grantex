import type { MPPCategory } from './types.js';

export const MPP_CATEGORY_TO_GRANTEX_SCOPE: Record<MPPCategory, string> = {
  'inference': 'payments:mpp:inference',
  'compute': 'payments:mpp:compute',
  'data': 'payments:mpp:data',
  'storage': 'payments:mpp:storage',
  'search': 'payments:mpp:search',
  'media': 'payments:mpp:media',
  'delivery': 'payments:mpp:delivery',
  'browser': 'payments:mpp:browser',
  'general': 'payments:mpp:general',
};

export const GRANTEX_SCOPE_TO_MPP_CATEGORY: Record<string, MPPCategory> = Object.fromEntries(
  Object.entries(MPP_CATEGORY_TO_GRANTEX_SCOPE).map(([k, v]) => [v, k as MPPCategory]),
) as Record<string, MPPCategory>;

export const ALL_MPP_CATEGORIES: MPPCategory[] = [
  'inference', 'compute', 'data', 'storage',
  'search', 'media', 'delivery', 'browser', 'general',
];

export function categoriesToScopes(categories: MPPCategory[]): string[] {
  return categories.map((c) => MPP_CATEGORY_TO_GRANTEX_SCOPE[c]);
}

export function scopesToCategories(scopes: string[]): MPPCategory[] {
  return scopes
    .filter((s) => s.startsWith('payments:mpp:'))
    .map((s) => GRANTEX_SCOPE_TO_MPP_CATEGORY[s])
    .filter((c): c is MPPCategory => c !== undefined);
}
