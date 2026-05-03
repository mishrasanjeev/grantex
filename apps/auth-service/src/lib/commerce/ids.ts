import { ulid } from 'ulid';

export const newCommerceTenantId = (): string => `cten_${ulid()}`;
export const newMerchantId = (): string => `mch_${ulid()}`;
export const newCommerceAgentId = (): string => `cag_${ulid()}`;
export const newCommerceProductId = (): string => `cprd_${ulid()}`;
export const newCommerceVariantId = (): string => `cvar_${ulid()}`;
export const newCommerceAuditId = (): string => `caud_${ulid()}`;
