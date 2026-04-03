/**
 * Region configuration for DPDP Act (India) and EU compliance.
 */

import type { RegionConfig } from '../types.js';

/**
 * India — Digital Personal Data Protection Act, 2023.
 */
export const REGION_IN: RegionConfig = {
  regionCode: 'IN',
  regionName: 'India',
  dataResidencyRequired: true,
  consentMinAge: 18,
  grievanceResolutionDays: 7,
  defaultLanguage: 'en',
  supportedLanguages: ['en', 'hi', 'bn', 'te', 'mr', 'ta', 'gu', 'kn', 'ml', 'pa', 'or'],
  regulatoryAuthority: 'Data Protection Board of India',
  regulatoryUrl: 'https://www.meity.gov.in/data-protection-framework',
};

/**
 * European Union — GDPR + EU AI Act.
 */
export const REGION_EU: RegionConfig = {
  regionCode: 'EU',
  regionName: 'European Union',
  dataResidencyRequired: true,
  consentMinAge: 16,
  grievanceResolutionDays: 30,
  defaultLanguage: 'en',
  supportedLanguages: [
    'en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'sv', 'da',
    'fi', 'el', 'cs', 'ro', 'hu', 'sk', 'bg', 'hr', 'lt', 'lv',
    'et', 'sl', 'mt', 'ga',
  ],
  regulatoryAuthority: 'European Data Protection Board',
  regulatoryUrl: 'https://edpb.europa.eu/',
};

/**
 * All supported regions.
 */
export const REGIONS: Record<string, RegionConfig> = {
  IN: REGION_IN,
  EU: REGION_EU,
};

/**
 * Get region config by region code.
 */
export function getRegion(code: string): RegionConfig | undefined {
  return REGIONS[code.toUpperCase()];
}
