// ─── Client configuration ────────────────────────────────────────────────────

export interface GrantexClientOptions {
  /** Grantex API key. Defaults to GRANTEX_API_KEY env variable. */
  apiKey?: string;
  /** Base URL for the Grantex API. Defaults to https://api.grantex.dev */
  baseUrl?: string;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
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
