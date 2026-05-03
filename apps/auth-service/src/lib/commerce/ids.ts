import { ulid } from 'ulid';
import { randomBytes } from 'node:crypto';

export const newCommerceTenantId = (): string => `cten_${ulid()}`;
export const newMerchantId = (): string => `mch_${ulid()}`;
export const newCommerceAgentId = (): string => `cag_${ulid()}`;
export const newCommerceProductId = (): string => `cprd_${ulid()}`;
export const newCommerceVariantId = (): string => `cvar_${ulid()}`;
export const newCommerceAuditId = (): string => `caud_${ulid()}`;

// M2 — passport / consent / merchant key / passport key id generators.
export const newCommerceConsentRecordId = (): string => `crec_${ulid()}`;
export const newCommercePassportJti = (): string => `cpsp_${ulid()}`;
export const newCommerceMerchantApiKeyId = (): string => `mkey_${ulid()}`;

// Opaque CSPRNG identifier shown in consent URL. 192 bits to comfortably
// exceed spec §14's 128-bit minimum.
export const newConsentRequestId = (): string => randomBytes(24).toString('base64url');

// commerce-passport-YYYYMMDD-XXXXXXXX (spec §6).
export function newCommercePassportKid(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(4).toString('hex');  // 8 hex chars
  return `commerce-passport-${y}${m}${d}-${suffix}`;
}
