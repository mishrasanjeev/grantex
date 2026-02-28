// ─── Client configuration ────────────────────────────────────────────────────

export interface GrantexClientOptions {
  /** Grantex API key. Defaults to GRANTEX_API_KEY env variable. */
  apiKey?: string;
  /** Base URL for the Grantex API. Defaults to https://api.grantex.dev */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
}

// ─── Signup ─────────────────────────────────────────────────────────────────

export interface SignupParams {
  name: string;
  email?: string;
}

export interface SignupResponse {
  developerId: string;
  apiKey: string;
  name: string;
  email: string | null;
  mode: 'live' | 'sandbox';
  createdAt: string;
}

export interface RotateKeyResponse {
  apiKey: string;
  rotatedAt: string;
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface RegisterAgentParams {
  name: string;
  description: string;
  scopes: string[];
}

export interface UpdateAgentParams {
  name?: string;
  description?: string;
  scopes?: string[];
}

export interface Agent {
  id: string;
  did: string;
  name: string;
  description: string;
  scopes: string[];
  status: 'active' | 'suspended' | 'revoked';
  developerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListAgentsResponse {
  agents: Agent[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Authorization ────────────────────────────────────────────────────────────

export interface AuthorizeParams {
  agentId: string;
  /** Your app's user identifier — mapped to principalId in the request body. */
  userId: string;
  scopes: string[];
  expiresIn?: string;
  redirectUri?: string;
  /** PKCE S256 code challenge (from generatePkce()) */
  codeChallenge?: string;
  /** Must be 'S256' when codeChallenge is provided */
  codeChallengeMethod?: string;
}

export interface AuthorizationRequest {
  authRequestId: string;
  consentUrl: string;
  agentId: string;
  principalId: string;
  scopes: string[];
  expiresIn: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
}

// ─── Grants ───────────────────────────────────────────────────────────────────

export interface Grant {
  id: string;
  agentId: string;
  agentDid: string;
  principalId: string;
  developerId: string;
  scopes: string[];
  status: 'active' | 'revoked' | 'expired';
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface ListGrantsParams {
  agentId?: string;
  principalId?: string;
  status?: 'active' | 'revoked' | 'expired';
  page?: number;
  pageSize?: number;
}

export interface ListGrantsResponse {
  grants: Grant[];
  total: number;
  page: number;
  pageSize: number;
}

export interface VerifiedGrant {
  /** Grant/token unique ID (jti claim) */
  tokenId: string;
  /** Grant record ID */
  grantId: string;
  /** The end-user who authorized this agent (sub claim) */
  principalId: string;
  /** The agent's DID (agt claim) */
  agentDid: string;
  /** Developer org (dev claim) */
  developerId: string;
  /** Granted scopes (scp claim) */
  scopes: string[];
  /** Token issued-at timestamp (seconds since epoch) */
  issuedAt: number;
  /** Token expiry timestamp (seconds since epoch) */
  expiresAt: number;
  /** Parent agent DID (delegated grants only) */
  parentAgentDid?: string;
  /** Parent grant ID (delegated grants only) */
  parentGrantId?: string;
  /** Delegation depth (0 = root, n = nth-level delegation) */
  delegationDepth?: number;
}

export interface DelegateParams {
  parentGrantToken: string;
  subAgentId: string;
  scopes: string[];
  expiresIn?: string;
}

// ─── Tokens ───────────────────────────────────────────────────────────────────

export interface ExchangeTokenParams {
  code: string;
  agentId: string;
  /** PKCE code verifier (from generatePkce()) — required if codeChallenge was sent in authorize */
  codeVerifier?: string;
}

export interface ExchangeTokenResponse {
  grantToken: string;
  expiresAt: string;
  scopes: string[];
  refreshToken: string;
  grantId: string;
}

export interface RefreshTokenParams {
  refreshToken: string;
  agentId: string;
}

export interface VerifyTokenResponse {
  valid: boolean;
  grantId?: string;
  scopes?: string[];
  principal?: string;
  agent?: string;
  expiresAt?: string;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export interface LogAuditParams {
  agentId: string;
  grantId: string;
  action: string;
  metadata?: Record<string, unknown>;
  status?: 'success' | 'failure' | 'blocked';
}

export interface AuditEntry {
  entryId: string;
  agentId: string;
  agentDid: string;
  grantId: string;
  principalId: string;
  action: string;
  metadata: Record<string, unknown>;
  hash: string;
  prevHash: string | null;
  timestamp: string;
  status: 'success' | 'failure' | 'blocked';
}

export interface ListAuditParams {
  agentId?: string;
  grantId?: string;
  principalId?: string;
  action?: string;
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

export interface ListAuditResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

export type WebhookEventType = 'grant.created' | 'grant.revoked' | 'token.issued';

export interface CreateWebhookParams {
  url: string;
  events: WebhookEventType[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  createdAt: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

export interface ListWebhooksResponse {
  webhooks: WebhookEndpoint[];
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export interface VerifyGrantTokenOptions {
  jwksUri: string;
  requiredScopes?: string[];
  audience?: string;
  /** @internal override clock for testing */
  clockTolerance?: number;
}

// ─── Raw JWT payload shape ────────────────────────────────────────────────────

export interface GrantTokenPayload {
  iss: string;
  sub: string;
  agt: string;
  dev: string;
  scp: string[];
  iat: number;
  exp: number;
  jti: string;
  /** Grant record ID embedded as a custom claim */
  grnt?: string;
  parentAgt?: string;
  parentGrnt?: string;
  delegationDepth?: number;
}

// ─── Billing ──────────────────────────────────────────────────────────────────

export interface SubscriptionStatus {
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'past_due' | 'canceled';
  currentPeriodEnd: string | null;
}

export interface CreateCheckoutParams {
  plan: 'pro' | 'enterprise';
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResponse {
  checkoutUrl: string;
}

export interface CreatePortalParams {
  returnUrl: string;
}

export interface PortalResponse {
  portalUrl: string;
}

// ─── Policies ─────────────────────────────────────────────────────────────────

export interface Policy {
  id: string;
  name: string;
  effect: 'allow' | 'deny';
  priority: number;
  agentId: string | null;
  principalId: string | null;
  scopes: string[] | null;
  timeOfDayStart: string | null;
  timeOfDayEnd: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyParams {
  name: string;
  effect: 'allow' | 'deny';
  priority?: number;
  agentId?: string;
  principalId?: string;
  scopes?: string[];
  timeOfDayStart?: string;
  timeOfDayEnd?: string;
}

export interface UpdatePolicyParams {
  name?: string;
  effect?: 'allow' | 'deny';
  priority?: number;
  agentId?: string | null;
  principalId?: string | null;
  scopes?: string[] | null;
  timeOfDayStart?: string | null;
  timeOfDayEnd?: string | null;
}

export interface ListPoliciesResponse {
  policies: Policy[];
  total: number;
}

// ─── Compliance ───────────────────────────────────────────────────────────────

export interface ComplianceSummary {
  generatedAt: string;
  since?: string;
  until?: string;
  agents: { total: number; active: number; suspended: number; revoked: number };
  grants: { total: number; active: number; revoked: number; expired: number };
  auditEntries: { total: number; success: number; failure: number; blocked: number };
  policies: { total: number };
  plan: string;
}

export interface ComplianceExportGrantsParams {
  since?: string;
  until?: string;
  status?: 'active' | 'revoked' | 'expired';
}

export interface ComplianceExportAuditParams {
  since?: string;
  until?: string;
  agentId?: string;
  status?: 'success' | 'failure' | 'blocked';
}

export interface ComplianceGrantsExport {
  generatedAt: string;
  total: number;
  grants: Grant[];
}

export interface ComplianceAuditExport {
  generatedAt: string;
  total: number;
  entries: AuditEntry[];
}

export interface EvidencePackParams {
  since?: string;
  until?: string;
  framework?: 'soc2' | 'gdpr' | 'all';
}

export interface ChainIntegrity {
  valid: boolean;
  checkedEntries: number;
  firstBrokenAt: string | null;
}

export interface EvidencePack {
  meta: {
    schemaVersion: '1.0';
    generatedAt: string;
    since?: string;
    until?: string;
    framework: 'soc2' | 'gdpr' | 'all';
  };
  summary: {
    agents: { total: number; active: number; suspended: number; revoked: number };
    grants: { total: number; active: number; revoked: number; expired: number };
    auditEntries: { total: number; success: number; failure: number; blocked: number };
    policies: { total: number };
    plan: string;
  };
  grants: Grant[];
  auditEntries: AuditEntry[];
  policies: Policy[];
  chainIntegrity: ChainIntegrity;
}

// ─── Anomalies ────────────────────────────────────────────────────────────────

export type AnomalyType = 'rate_spike' | 'high_failure_rate' | 'new_principal' | 'off_hours_activity';
export type AnomalySeverity = 'low' | 'medium' | 'high';

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  agentId: string | null;
  principalId: string | null;
  description: string;
  metadata: Record<string, unknown>;
  detectedAt: string;
  acknowledgedAt: string | null;
}

export interface DetectAnomaliesResponse {
  detectedAt: string;
  total: number;
  anomalies: Anomaly[];
}

export interface ListAnomaliesResponse {
  anomalies: Anomaly[];
  total: number;
}

// ─── SCIM ─────────────────────────────────────────────────────────────────────

export interface ScimEmail {
  value: string;
  primary?: boolean;
}

export interface ScimUserMeta {
  resourceType: string;
  created: string;
  lastModified: string;
}

export interface ScimUser {
  id: string;
  externalId?: string;
  userName: string;
  displayName?: string;
  active: boolean;
  emails: ScimEmail[];
  meta: ScimUserMeta;
}

export interface ScimListResponse {
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ScimUser[];
}

export interface CreateScimUserParams {
  userName: string;
  displayName?: string;
  externalId?: string;
  emails?: ScimEmail[];
  active?: boolean;
}

export interface UpdateScimUserParams {
  userName?: string;
  displayName?: string;
  active?: boolean;
  emails?: ScimEmail[];
}

export interface ScimToken {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ScimTokenWithSecret extends ScimToken {
  token: string;
}

export interface CreateScimTokenParams {
  label: string;
}

export interface ListScimTokensResponse {
  tokens: ScimToken[];
}

// ─── SSO ──────────────────────────────────────────────────────────────────────

export interface SsoConfig {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSsoConfigParams {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface SsoLoginResponse {
  authorizeUrl: string;
}

export interface SsoCallbackResponse {
  email: string | null;
  name: string | null;
  sub: string | null;
  developerId: string;
}
