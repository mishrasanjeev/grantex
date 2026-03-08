// Main client
export { Grantex } from './client.js';

// Standalone token verification (no Grantex account needed)
export { verifyGrantToken } from './verify.js';

// Webhook signature verification
export { verifyWebhookSignature } from './webhook.js';

// PKCE helper
export { generatePkce, type PkceChallenge } from './pkce.js';

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
} from './types.js';
