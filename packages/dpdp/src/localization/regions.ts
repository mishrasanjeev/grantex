/**
 * Region configuration for DPDP Act (India) and EU compliance.
 */

import type { RegionConfig } from '../types.js';

/**
 * India — Digital Personal Data Protection Act, 2023.
 *
 * - Not a data-localisation regime: DPDP Act s.16 permits transfer outside
 *   India except to countries the Central Government restricts by notification.
 * - A child is an individual under 18 (s.2(f)); processing a child's data needs
 *   verifiable parental consent (s.9).
 * - Grievances: the data fiduciary publishes its response period, at most 90
 *   days (DPDP Rules 2025 r.14(3)).
 */
export const REGION_IN: RegionConfig = {
  regionCode: 'IN',
  regionName: 'India',
  dataResidencyRequired: false,
  consentMinAge: 18,
  consentMinAgeRange: { min: 18, max: 18 },
  grievanceResolutionDays: 90,
  defaultLanguage: 'en',
  supportedLanguages: ['en', 'hi', 'bn', 'te', 'mr', 'ta', 'gu', 'kn', 'ml', 'pa', 'or'],
  regulatoryAuthority: 'Data Protection Board of India',
  regulatoryUrl: 'https://www.meity.gov.in/data-protection-framework',
};

/**
 * European Union — GDPR + EU AI Act.
 *
 * - Age of digital consent: 16 under GDPR Art. 8(1), which member states may
 *   lower to no less than 13; so 13 to 16 depending on the member state.
 *   `consentMinAge` is the highest value; check the member state's age.
 * - Not a data-localisation regime: GDPR Chapter V governs transfers outside
 *   the EU/EEA (adequacy, appropriate safeguards), it does not require storage
 *   in the EU.
 */
export const REGION_EU: RegionConfig = {
  regionCode: 'EU',
  regionName: 'European Union',
  dataResidencyRequired: false,
  consentMinAge: 16,
  consentMinAgeRange: { min: 13, max: 16 },
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
