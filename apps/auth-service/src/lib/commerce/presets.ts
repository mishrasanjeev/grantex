export const ELECTRONICS_APPLIANCES = 'electronics_appliances' as const;

export const COMMERCE_CATEGORY_PRESETS = [ELECTRONICS_APPLIANCES] as const;

export type CommerceCategoryPreset = typeof COMMERCE_CATEGORY_PRESETS[number];

export function isCommerceCategoryPreset(value: unknown): value is CommerceCategoryPreset {
  return typeof value === 'string'
    && (COMMERCE_CATEGORY_PRESETS as readonly string[]).includes(value);
}
