// Main client
export { Grantex } from './client.js';

// Standalone token verification (no Grantex account needed)
export { verifyGrantToken } from './verify.js';

// Webhook signature verification
export { verifyWebhookSignature, verifyWebhook, type VerifyWebhookOptions } from './webhook.js';

// PKCE helper
export { generatePkce, type PkceChallenge } from './pkce.js';

// OAuth agent-grants profile client (PAR + PKCE + RFC 9207 + DPoP)
export {
  OAuthAgentClient,
  generateOAuthAgentKey,
  type OAuthAuthorizationServerMetadata,
  type OAuthAgentClientOptions,
  type OAuthAgentKeyPair,
  type OAuthAgentRefreshOptions,
  type BeginAgentAuthorizationOptions,
  type PendingAgentAuthorization,
  type OAuthAgentTokenResponse,
} from './oauth-agent.js';

// Agent prepaid wallets and x402 authorization bridge
export {
  PrepaidWalletAgentClient,
  PrincipalPrepaidWalletClient,
  DeveloperPrepaidWalletPolicyClient,
  type PrepaidCustodyMode,
  type PrepaidWalletStatus,
  type WalletAssignmentStatus,
  type PrepaidWallet,
  type AssignedPrepaidWallet,
  type WalletAssignment,
  type CreatePrepaidWalletParams,
  type AssignPrepaidWalletParams,
  type PrepaidAuthorizationRequest,
  type PrepaidAuthorizationResponse,
  type PrepaidAuthorization,
  type PrepaidApprovalRequired,
  type WalletSpendPolicyScope,
  type WalletSpendPolicyEffect,
  type WalletSpendPolicyWindow,
  type WalletSpendPolicyStatus,
  type WalletSpendPolicyInput,
  type WalletSpendPolicy,
  type WalletPaymentApproval,
  type WalletReloadRequest,
  type PrepaidWalletActivity,
} from './prepaid-wallets.js';

// Error classes
export {
  GrantexError,
  GrantexApiError,
  GrantexAuthError,
  GrantexTokenError,
  GrantexNetworkError,
} from './errors.js';

// Event streaming
export { EventsClient, type GrantexEvent as GrantexStreamEvent, type StreamOptions, type EventHandler } from './resources/events.js';

// Passports (MPP Agent Identity)
export {
  PassportsClient,
  type IssuePassportParams,
  type IssuedPassportResponse,
  type GetPassportResponse,
  type RevokePassportResponse,
  type ListPassportsParams,
} from './resources/passports.js';

// Scope enforcement
export { ToolManifest, Permission, permissionCovers, type EnforceOptions, type EnforceResult, type ToolManifestOptions, type WrapToolOptions, type EnforceMiddlewareOptions } from './manifest.js';

// DPDP Compliance
export { DpdpClient } from './resources/dpdp.js';

// Commerce V1 / OACP control plane
export {
  CommerceClient,
  type CommerceEnvironment,
  type CommerceProviderKey,
  type CommercePassportType,
  type CommercePaymentStatus,
  type CommerceRecord,
  type CommerceDataResponse,
  type CommerceListResponse,
  type CommerceProfile,
  type CommerceIdempotentRequest,
  type CommerceTenantCreateParams,
  type CommerceTenantUpdateParams,
  type CommerceDeveloperTenantBindParams,
  type CommerceMerchantCreateParams,
  type CommerceMerchantUpdateParams,
  type CommerceAgentCreateParams,
  type CommerceAgentUpdateParams,
  type CommerceCatalogVariantInput,
  type CommerceCatalogProductCreateParams,
  type CommerceCatalogProductUpdateParams,
  type CommerceCatalogProductListParams,
  type CommerceCatalogSearchParams,
  type CommerceCartCreateParams,
  type CommerceConsentRequestCreateParams,
  type CommerceConsentExchangeParams,
  type CommercePassportVerifyParams,
  type CommercePassportRevokeParams,
  type CommercePolicyCreateParams,
  type CommercePolicyEvaluateParams,
  type CommercePaymentIntentCreateParams,
  type CommercePaymentIntentListParams,
  type CommerceCheckoutLinkCreateParams,
  type CommerceProviderCredentialCreateParams,
  type CommerceProviderCredentialPatchParams,
  type CommerceProviderCredentialListParams,
  type CommerceWebhookSourceCreateParams,
  type CommerceWebhookSourceListParams,
  type CommerceOpsHealthParams,
  type CommerceProviderWebhookEventListParams,
  type CommerceProviderWebhookReplayParams,
  type CommerceMcpJsonRpcRequest,
} from './resources/commerce.js';

// Types
export type {
  RateLimit,
  GrantexClientOptions,
  // Signup
  SignupParams,
  SignupResponse,
  RotateKeyResponse,
  // Agents
  Agent,
  RegisterAgentParams,
  UpdateAgentParams,
  ListAgentsResponse,
  // Authorization
  AuthorizeParams,
  AuthorizationRequest,
  // Grants
  Grant,
  ListGrantsParams,
  ListGrantsResponse,
  VerifiedGrant,
  DelegateParams,
  // Tokens
  ExchangeTokenParams,
  ExchangeTokenResponse,
  RefreshTokenParams,
  VerifyTokenResponse,
  // Principal Sessions
  CreatePrincipalSessionParams,
  PrincipalSessionResponse,
  // Audit
  LogAuditParams,
  AuditEntry,
  AuditCheckpoint,
  ListAuditParams,
  ListAuditResponse,
  // Verify
  VerifyGrantTokenOptions,
  // Webhooks
  WebhookEventType,
  CreateWebhookParams,
  WebhookEndpoint,
  WebhookEndpointWithSecret,
  ListWebhooksResponse,
  // Billing
  SubscriptionStatus,
  CreateCheckoutParams,
  CheckoutResponse,
  CreatePortalParams,
  PortalResponse,
  // Policies
  Policy,
  CreatePolicyParams,
  UpdatePolicyParams,
  ListPoliciesResponse,
  // Anomalies
  AnomalyType,
  AnomalySeverity,
  Anomaly,
  DetectAnomaliesResponse,
  ListAnomaliesResponse,
  // SCIM
  ScimEmail,
  ScimUserMeta,
  ScimUser,
  ScimListResponse,
  CreateScimUserParams,
  UpdateScimUserParams,
  ScimToken,
  ScimTokenWithSecret,
  CreateScimTokenParams,
  ListScimTokensResponse,
  // SSO
  SsoConfig,
  CreateSsoConfigParams,
  SsoLoginResponse,
  SsoCallbackResponse,
  // Vault
  StoreCredentialParams,
  StoreCredentialResponse,
  VaultCredential,
  ListVaultCredentialsParams,
  ListVaultCredentialsResponse,
  ExchangeCredentialParams,
  ExchangeCredentialResponse,
  // Budgets
  AllocateBudgetParams,
  BudgetAllocation,
  DebitBudgetParams,
  DebitBudgetResponse,
  BudgetTransaction,
  BudgetTransactionsResponse,
  // Compliance
  ComplianceSummary,
  ComplianceExportGrantsParams,
  ComplianceExportAuditParams,
  ComplianceGrantsExport,
  ComplianceAuditExport,
  EvidencePackParams,
  EvidencePack,
  ChainIntegrity,
  // Usage
  UsageResponse,
  UsageHistoryEntry,
  UsageHistoryResponse,
  // Custom Domains
  CreateDomainParams,
  CreateDomainResponse,
  DomainEntry,
  ListDomainsResponse,
  VerifyDomainResponse,
  // WebAuthn / FIDO
  WebAuthnRegistrationOptions,
  WebAuthnRegistrationVerifyParams,
  WebAuthnCredential,
  ListWebAuthnCredentialsResponse,
  // Verifiable Credentials
  VerifiableCredentialRecord,
  ListCredentialsParams,
  ListCredentialsResponse,
  VCVerificationResult,
  // SD-JWT
  SDJWTPresentParams,
  SDJWTPresentResult,
  // Developer Settings
  UpdateDeveloperSettingsParams,
  UpdateDeveloperSettingsResponse,
  // DPDP Compliance
  DpdpPurpose,
  CreateConsentRecordParams,
  ConsentRecord,
  ListConsentRecordsResponse,
  WithdrawConsentParams,
  WithdrawConsentResponse,
  PrincipalRecordsResponse,
  ErasureResponse,
  CreateConsentNoticeParams,
  ConsentNotice,
  FileGrievanceParams,
  Grievance,
  DpdpExportType,
  CreateDpdpExportParams,
  DpdpExport,
} from './types.js';
