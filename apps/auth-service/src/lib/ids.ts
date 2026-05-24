import { ulid } from 'ulid';

export const newAgentId = (): string => `ag_${ulid()}`;
export const newGrantId = (): string => `grnt_${ulid()}`;
export const newTokenId = (): string => `tok_${ulid()}`;
export const newRefreshTokenId = (): string => `ref_${ulid()}`;
export const newAuthRequestId = (): string => `areq_${ulid()}`;
export const newAuditEntryId = (): string => `alog_${ulid()}`;
export const newDeveloperId = (): string => `dev_${ulid()}`;
export const newWebhookId = (): string => `wh_${ulid()}`;
export const newSubscriptionId = (): string => `sub_${ulid()}`;
export const newPolicyId = (): string => `pol_${ulid()}`;
export const newAnomalyId = (): string => `anm_${ulid()}`;
export const newScimTokenId = (): string => `scimtok_${ulid()}`;
export const newScimUserId = (): string => `scimuser_${ulid()}`;
export const newVaultCredentialId = (): string => `vault_${ulid()}`;
export const newBudgetAllocationId = (): string => `bdg_${ulid()}`;
export const newBudgetTransactionId = (): string => `btx_${ulid()}`;
export const newUsageDailyId = (): string => `usg_${ulid()}`;
export const newPolicyBundleId = (): string => `pbnd_${ulid()}`;
export const newSigningKeyId = (): string => `key_${ulid()}`;
export const newWebAuthnCredentialId = (): string => `cred_${ulid()}`;
export const newWebAuthnChallengeId = (): string => `wac_${ulid()}`;
export const newVerifiableCredentialId = (): string => `vc_${ulid()}`;
export const newStatusListId = (): string => `vcsl_${ulid()}`;
export const newPresentationId = (): string => `pres_${ulid()}`;
export const newSsoConnectionId = (): string => `sso_${ulid()}`;
export const newSsoSessionId = (): string => `ssosess_${ulid()}`;
export const newConsentBundleId = (): string => `bundle_${ulid()}`;
export const newOfflineAuditEntryId = (): string => `oae_${ulid()}`;
export const newMcpServerId = (): string => `mcp_srv_${ulid()}`;
export const newCertificationId = (): string => `cert_${ulid()}`;
export const newConsentRecordId = (): string => `crec_${ulid()}`;
export const newNoticeId = (): string => `notice_${ulid()}`;
export const newGrievanceId = (): string => `grv_${ulid()}`;
export const newExportId = (): string => `exp_${ulid()}`;

// Externally exposed DPDP reference numbers / request IDs.
// These travel back to the data principal and appear in audit logs, so they
// must be non-enumerable. ULID gives 26 Crockford-base32 chars (~125 bits of
// entropy + monotonic time prefix) while still being short and copy-friendly.
export const newGrievanceReference = (): string =>
  `GRV-${new Date().getUTCFullYear()}-${ulid()}`;
export const newErasureRequestId = (): string =>
  `ER-${new Date().getUTCFullYear()}-${ulid()}`;
export const newRegistryAgentId = (): string => `ragent_${ulid()}`;
export const newAnomalyRuleId = (): string => `arule_${ulid()}`;
export const newAnomalyChannelId = (): string => `achan_${ulid()}`;
