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

// ─── Verify ───────────────────────────────────────────────────────────────────

export interface VerifyGrantTokenOptions {
  jwksUri: string;
  requiredScopes?: string[];
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
  gid?: string;
}
