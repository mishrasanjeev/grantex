import { ulid } from 'ulid';

export const newAgentId = (): string => `ag_${ulid()}`;
export const newGrantId = (): string => `grnt_${ulid()}`;
export const newTokenId = (): string => `tok_${ulid()}`;
export const newRefreshTokenId = (): string => `ref_${ulid()}`;
export const newAuthRequestId = (): string => `areq_${ulid()}`;
export const newAuditEntryId = (): string => `alog_${ulid()}`;
export const newDeveloperId = (): string => `dev_${ulid()}`;
export const newWebhookId = (): string => `wh_${ulid()}`;
