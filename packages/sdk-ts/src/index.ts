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

// Types
export type {
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
  // Compliance
  ComplianceSummary,
  ComplianceExportGrantsParams,
  ComplianceExportAuditParams,
  ComplianceGrantsExport,
  ComplianceAuditExport,
  EvidencePackParams,
  EvidencePack,
  ChainIntegrity,
} from './types.js';
