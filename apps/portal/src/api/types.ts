// ── Developer ────────────────────────────────────────────────────────────
export interface Developer {
  developerId: string;
  name: string;
  email: string | null;
  mode: 'live' | 'sandbox';
  plan: string;
  createdAt: string;
}

export interface SignupRequest {
  name: string;
  email?: string;
}

export interface SignupResponse extends Developer {
  apiKey: string;
}

export interface RotateKeyResponse {
  apiKey: string;
  rotatedAt: string;
}

// ── Agents ───────────────────────────────────────────────────────────────
export interface Agent {
  agentId: string;
  did: string;
  developerId: string;
  name: string;
  description: string | null;
  scopes: string[];
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentRequest {
  name: string;
  description?: string;
  scopes: string[];
}

// ── Grants ───────────────────────────────────────────────────────────────
export interface Grant {
  grantId: string;
  agentId: string;
  principalId: string;
  developerId: string;
  scopes: string[];
  status: 'active' | 'revoked' | 'expired';
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  parentGrantId?: string;
  delegationDepth: number;
}

// ── Audit ────────────────────────────────────────────────────────────────
export interface AuditEntry {
  entryId: string;
  agentId: string;
  agentDid: string;
  grantId: string;
  principalId: string;
  developerId: string;
  action: string;
  metadata: Record<string, unknown>;
  hash: string;
  prevHash: string | null;
  timestamp: string;
  status: 'success' | 'failure' | 'blocked';
}

// ── Policies ─────────────────────────────────────────────────────────────
export interface Policy {
  id: string;
  developerId: string;
  name: string;
  effect: 'allow' | 'deny';
  scopes: string[];
  conditions: Record<string, unknown>;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyRequest {
  name: string;
  effect: 'allow' | 'deny';
  scopes: string[];
  conditions?: Record<string, unknown>;
  priority?: number;
}

// ── Anomalies ────────────────────────────────────────────────────────────
export interface Anomaly {
  id: string;
  developerId: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  acknowledged: boolean;
  createdAt: string;
}

// ── Compliance ───────────────────────────────────────────────────────────
export interface ComplianceSummary {
  totalGrants: number;
  activeGrants: number;
  revokedGrants: number;
  totalAgents: number;
  auditEntries: number;
  anomalies: number;
  complianceScore: number;
}

// ── Billing ──────────────────────────────────────────────────────────────
export interface Subscription {
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
}

// ── List response wrapper ────────────────────────────────────────────────
export interface ListResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ── Stats ────────────────────────────────────────────────────────────────
export interface DashboardStats {
  agents: number;
  activeGrants: number;
  auditEntries: number;
  anomalies: number;
}
