import type { OAuthAgentClient } from './oauth-agent.js';

export type PrepaidCustodyMode = 'sandbox_ledger' | 'external';
export type PrepaidWalletStatus = 'active' | 'blocked' | 'closed';
export type WalletAssignmentStatus = 'active' | 'blocked' | 'revoked';
export type WalletSpendPolicyScope = 'assignment' | 'wallet' | 'agent' | 'group' | 'principal' | 'developer';
export type WalletSpendPolicyEffect = 'limit' | 'deny' | 'require_approval';
export type WalletSpendPolicyWindow = 'per_authorization' | 'rolling' | 'calendar_day' | 'calendar_week' | 'calendar_month' | 'lifetime';
export type WalletSpendPolicyStatus = 'active' | 'disabled' | 'revoked';

export interface PrepaidWallet {
  walletId: string;
  principalId: string;
  name: string;
  custodyMode: PrepaidCustodyMode;
  provider: string | null;
  providerWalletId: string | null;
  walletAddress: string | null;
  network: string;
  asset: string;
  decimals: number;
  availableAmount: string;
  reservedAmount: string;
  lowBalanceThreshold: string;
  maxBalance: string | null;
  maxReloadAmount: string | null;
  reloadCumulativeLimit: string | null;
  reloadPeriodSeconds: number | null;
  reloadCountLimit: number | null;
  status: PrepaidWalletStatus;
  blockedAt: string | null;
  blockedReason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Agent-visible wallet projection. Custody provider identifiers and metadata are never exposed. */
export interface AssignedPrepaidWallet {
  walletId: string;
  name: string;
  network: string;
  asset: string;
  decimals: number;
  availableAmount: string;
  reservedAmount: string;
  lowBalanceThreshold: string;
  status: PrepaidWalletStatus;
  blockedAt: string | null;
  blockedReason: string | null;
  assignmentId: string;
  assignmentStatus: WalletAssignmentStatus;
  perTransactionLimit: string;
  cumulativeLimit: string;
  cumulativePeriodSeconds: number;
  allowedRecipients: string[];
  allowedScopes: string[];
  allowedResourceOrigins: string[];
  allowAnyRecipient: boolean;
  allowAnyScope: boolean;
  allowAnyResource: boolean;
  budgetGroup: string | null;
  validFrom: string;
  validUntil: string | null;
  allWalletsBlocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WalletAssignment {
  assignmentId: string;
  walletId: string;
  agentId: string;
  principalId: string;
  status: WalletAssignmentStatus;
  perTransactionLimit: string;
  cumulativeLimit: string;
  cumulativePeriodSeconds: number;
  allowedRecipients: string[];
  allowedScopes: string[];
  allowedResourceOrigins: string[];
  allowAnyRecipient: boolean;
  allowAnyScope: boolean;
  allowAnyResource: boolean;
  budgetGroup: string | null;
  validFrom: string;
  validUntil: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePrepaidWalletParams {
  name: string;
  custodyMode: PrepaidCustodyMode;
  provider?: string;
  providerWalletId?: string;
  walletAddress?: string;
  network: string;
  asset: string;
  decimals?: number;
  lowBalanceThreshold?: string;
  maxBalance?: string;
  maxReloadAmount?: string;
  reloadCumulativeLimit?: string;
  reloadPeriodSeconds?: number;
  reloadCountLimit?: number;
  metadata?: Record<string, unknown>;
}

export interface AssignPrepaidWalletParams {
  agentId: string;
  perTransactionLimit: string;
  cumulativeLimit: string;
  cumulativePeriodSeconds: number;
  allowedRecipients?: string[];
  allowedScopes?: string[];
  allowedResourceOrigins?: string[];
  allowAnyRecipient?: boolean;
  allowAnyScope?: boolean;
  allowAnyResource?: boolean;
  budgetGroup?: string;
  validUntil?: string;
}

export interface PrepaidAuthorizationRequest {
  walletId?: string;
  amount: string;
  asset: string;
  network: string;
  recipient: string;
  resource: string;
  scope: string;
  maxTimeoutSeconds: number;
  idempotencyKey: string;
  approvalRequestId?: string;
  merchantId?: string;
  purpose?: string;
  projectId?: string;
  costCenter?: string;
}

export interface PrepaidAuthorization {
  authorization: string;
  reservationId: string;
  walletId: string;
  assignmentId: string;
  amount: string;
  asset: string;
  network: string;
  recipient: string;
  expiresAt: string;
  remainingAvailable: string;
  remainingCumulative: string;
  policyDecisionId: string | null;
}

export interface PrepaidApprovalRequired {
  status: 'approval_required';
  approvalRequestId: string;
  walletId: string;
  assignmentId: string;
  policyIds: string[];
  expiresAt: string;
}

export type PrepaidAuthorizationResponse = PrepaidAuthorization | PrepaidApprovalRequired;

export interface WalletSpendPolicyInput {
  name: string;
  description?: string;
  scopeType: WalletSpendPolicyScope;
  scopeId?: string;
  effect: WalletSpendPolicyEffect;
  onExceed?: 'deny' | 'require_approval';
  maxAmount?: string;
  maxCount?: number;
  windowType?: WalletSpendPolicyWindow;
  windowSeconds?: number;
  recipients?: string[];
  resourceOrigins?: string[];
  actionScopes?: string[];
  assets?: string[];
  networks?: string[];
  merchantIds?: string[];
  purposes?: string[];
  projectIds?: string[];
  costCenters?: string[];
  requireVerifiedMerchant?: boolean;
  priority?: number;
  validFrom?: string;
  validUntil?: string;
}

export interface WalletSpendPolicy {
  policyId: string;
  developerId: string;
  principalId: string | null;
  name: string;
  description: string | null;
  scopeType: WalletSpendPolicyScope;
  scopeId: string | null;
  effect: WalletSpendPolicyEffect;
  onExceed: 'deny' | 'require_approval';
  maxAmount: string | null;
  maxCount: number | null;
  windowType: WalletSpendPolicyWindow;
  windowSeconds: number | null;
  recipients: string[];
  resourceOrigins: string[];
  actionScopes: string[];
  assets: string[];
  networks: string[];
  merchantIds: string[];
  purposes: string[];
  projectIds: string[];
  costCenters: string[];
  requireVerifiedMerchant: boolean;
  priority: number;
  status: WalletSpendPolicyStatus;
  version: number;
  validFrom: string;
  validUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletPaymentApproval {
  approvalRequestId: string;
  walletId: string;
  assignmentId: string;
  agentId: string;
  amount: string;
  asset: string;
  network: string;
  recipient: string;
  resource: string;
  scope: string;
  merchantId: string | null;
  purpose: string | null;
  projectId: string | null;
  costCenter: string | null;
  policyIds: string[];
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';
  reason: string | null;
  expiresAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
  reservationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletReloadRequest {
  reloadRequestId: string;
  walletId: string;
  assignmentId: string | null;
  agentId: string | null;
  amount: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'funded';
  requestedBy: 'agent' | 'principal';
  externalReference: string | null;
  createdAt: string;
  decidedAt: string | null;
  fundedAt: string | null;
}

export interface PrepaidWalletActivity {
  assignments: WalletAssignment[];
  reservations: Array<Record<string, unknown>>;
  reloadRequests: WalletReloadRequest[];
  ledger: Array<Record<string, unknown>>;
  policyDecisions: Array<Record<string, unknown>>;
  paymentApprovals: WalletPaymentApproval[];
}

interface DpopResourceClient {
  fetch(input: string | URL, accessToken: string, init?: RequestInit): Promise<Response>;
}

export class PrepaidWalletAgentClient {
  readonly #oauthClient: DpopResourceClient;
  readonly #resourceUrl: string;
  #accessToken: string;

  constructor(options: {
    oauthClient: OAuthAgentClient | DpopResourceClient;
    accessToken: string;
    resourceUrl?: string;
  }) {
    if (!options.accessToken) throw new Error('accessToken is required');
    this.#oauthClient = options.oauthClient;
    const inferred = 'resource' in options.oauthClient
      ? String(options.oauthClient.resource)
      : undefined;
    this.#resourceUrl = normalizeUrl(options.resourceUrl ?? inferred ?? '');
    if (!this.#resourceUrl.endsWith('/v1/prepaid-wallets')) {
      throw new Error('resourceUrl must end with /v1/prepaid-wallets and match the OAuth resource audience');
    }
    this.#accessToken = options.accessToken;
  }

  setAccessToken(accessToken: string): void {
    if (!accessToken) throw new Error('accessToken is required');
    this.#accessToken = accessToken;
  }

  async list(): Promise<AssignedPrepaidWallet[]> {
    const response = await this.#oauthClient.fetch(this.#resourceUrl, this.#accessToken, {
      headers: { Accept: 'application/json' },
    });
    return (await walletJson<{ wallets: AssignedPrepaidWallet[] }>(response)).wallets;
  }

  async authorizePayment(params: PrepaidAuthorizationRequest): Promise<PrepaidAuthorizationResponse> {
    const response = await this.#oauthClient.fetch(
      `${this.#resourceUrl}/authorizations`,
      this.#accessToken,
      jsonRequest(params),
    );
    return walletJson<PrepaidAuthorizationResponse>(response);
  }

  async requestReload(
    walletId: string,
    amount: string,
    idempotencyKey: string,
    reason?: string,
  ): Promise<WalletReloadRequest> {
    const response = await this.#oauthClient.fetch(
      `${this.#resourceUrl}/${encodeURIComponent(walletId)}/reload-requests`,
      this.#accessToken,
      jsonRequest({ amount, idempotencyKey, ...(reason !== undefined ? { reason } : {}) }),
    );
    return walletJson<WalletReloadRequest>(response);
  }

  /** Callback passed directly to @grantex/x402 createX402Agent(). */
  readonly x402Authorizer = (params: PrepaidAuthorizationRequest) => this.authorizePayment(params);
}

export class PrincipalPrepaidWalletClient {
  readonly #baseUrl: string;
  #sessionToken: string;

  constructor(options: { baseUrl: string; sessionToken: string }) {
    this.#baseUrl = normalizeUrl(options.baseUrl);
    if (!options.sessionToken) throw new Error('sessionToken is required');
    this.#sessionToken = options.sessionToken;
  }

  setSessionToken(sessionToken: string): void {
    if (!sessionToken) throw new Error('sessionToken is required');
    this.#sessionToken = sessionToken;
  }

  create(params: CreatePrepaidWalletParams): Promise<PrepaidWallet> {
    return this.#request('/v1/principal/prepaid-wallets', jsonRequest(params));
  }

  async list(): Promise<PrepaidWallet[]> {
    return (await this.#request<{ wallets: PrepaidWallet[] }>('/v1/principal/prepaid-wallets')).wallets;
  }

  activity(walletId: string): Promise<PrepaidWalletActivity> {
    return this.#request(`/v1/principal/prepaid-wallets/${encodeURIComponent(walletId)}/activity`);
  }

  assign(walletId: string, params: AssignPrepaidWalletParams): Promise<WalletAssignment> {
    return this.#request(
      `/v1/principal/prepaid-wallets/${encodeURIComponent(walletId)}/assignments`,
      jsonRequest(params),
    );
  }

  setAssignmentStatus(assignmentId: string, status: WalletAssignmentStatus, reason?: string): Promise<WalletAssignment> {
    return this.#request(
      `/v1/principal/prepaid-wallet-assignments/${encodeURIComponent(assignmentId)}`,
      jsonRequest({ status, ...(reason !== undefined ? { reason } : {}) }, 'PATCH'),
    );
  }

  setWalletStatus(walletId: string, status: PrepaidWalletStatus, reason?: string): Promise<PrepaidWallet> {
    return this.#request(
      `/v1/principal/prepaid-wallets/${encodeURIComponent(walletId)}/status`,
      jsonRequest({ status, ...(reason !== undefined ? { reason } : {}) }, 'PATCH'),
    );
  }

  setAgentBlocked(agentId: string, blocked: boolean, reason?: string): Promise<{ agentId: string; allWalletsBlocked: boolean; reason: string | null }> {
    return this.#request(
      `/v1/principal/prepaid-wallet-agents/${encodeURIComponent(agentId)}/block`,
      jsonRequest({ blocked, ...(reason !== undefined ? { reason } : {}) }, 'PUT'),
    );
  }

  reload(walletId: string, amount: string, idempotencyKey: string, externalReference?: string): Promise<WalletReloadRequest> {
    return this.#request(
      `/v1/principal/prepaid-wallets/${encodeURIComponent(walletId)}/reloads`,
      jsonRequest({ amount, idempotencyKey, ...(externalReference !== undefined ? { externalReference } : {}) }),
    );
  }

  decideReload(requestId: string, decision: 'approved' | 'rejected'): Promise<WalletReloadRequest> {
    return this.#request(
      `/v1/principal/prepaid-wallet-reload-requests/${encodeURIComponent(requestId)}/decision`,
      jsonRequest({ decision }),
    );
  }

  fundReload(requestId: string, externalReference?: string): Promise<WalletReloadRequest> {
    return this.#request(
      `/v1/principal/prepaid-wallet-reload-requests/${encodeURIComponent(requestId)}/fund`,
      jsonRequest({ ...(externalReference !== undefined ? { externalReference } : {}) }),
    );
  }

  releaseReservation(reservationId: string, reason: string): Promise<{ reservationId: string; status: 'released' }> {
    return this.#request(
      `/v1/principal/prepaid-wallet-reservations/${encodeURIComponent(reservationId)}/release`,
      jsonRequest({ reason }),
    );
  }

  createSpendPolicy(params: WalletSpendPolicyInput): Promise<WalletSpendPolicy> {
    return this.#request('/v1/principal/prepaid-wallet-spend-policies', jsonRequest(params));
  }

  async listSpendPolicies(): Promise<WalletSpendPolicy[]> {
    return (await this.#request<{ policies: WalletSpendPolicy[] }>('/v1/principal/prepaid-wallet-spend-policies')).policies;
  }

  setSpendPolicyStatus(policyId: string, status: WalletSpendPolicyStatus): Promise<WalletSpendPolicy> {
    return this.#request(
      `/v1/principal/prepaid-wallet-spend-policies/${encodeURIComponent(policyId)}/status`,
      jsonRequest({ status }, 'PATCH'),
    );
  }

  async listPaymentApprovals(): Promise<WalletPaymentApproval[]> {
    return (await this.#request<{ approvals: WalletPaymentApproval[] }>('/v1/principal/prepaid-wallet-payment-approvals')).approvals;
  }

  decidePaymentApproval(
    approvalRequestId: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<WalletPaymentApproval> {
    return this.#request(
      `/v1/principal/prepaid-wallet-payment-approvals/${encodeURIComponent(approvalRequestId)}/decision`,
      jsonRequest({ decision, ...(reason !== undefined ? { reason } : {}) }),
    );
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#sessionToken}`);
    headers.set('Accept', 'application/json');
    const response = await fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    return walletJson<T>(response);
  }
}

/** Developer API-key client for organization-wide and cross-principal wallet policy. */
export class DeveloperPrepaidWalletPolicyClient {
  readonly #baseUrl: string;
  #apiKey: string;

  constructor(options: { baseUrl: string; apiKey: string }) {
    this.#baseUrl = normalizeUrl(options.baseUrl);
    if (!options.apiKey) throw new Error('apiKey is required');
    this.#apiKey = options.apiKey;
  }

  setApiKey(apiKey: string): void {
    if (!apiKey) throw new Error('apiKey is required');
    this.#apiKey = apiKey;
  }

  create(params: WalletSpendPolicyInput): Promise<WalletSpendPolicy> {
    return this.#request('/v1/prepaid-wallet-spend-policies', jsonRequest(params));
  }

  async list(): Promise<WalletSpendPolicy[]> {
    return (await this.#request<{ policies: WalletSpendPolicy[] }>('/v1/prepaid-wallet-spend-policies')).policies;
  }

  setStatus(policyId: string, status: WalletSpendPolicyStatus): Promise<WalletSpendPolicy> {
    return this.#request(
      `/v1/prepaid-wallet-spend-policies/${encodeURIComponent(policyId)}/status`,
      jsonRequest({ status }, 'PATCH'),
    );
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#apiKey}`);
    headers.set('Accept', 'application/json');
    return walletJson<T>(await fetch(`${this.#baseUrl}${path}`, { ...init, headers }));
  }
}

function normalizeUrl(value: string): string {
  if (!value) throw new Error('A base URL is required');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Base URLs must use HTTP or HTTPS');
  }
  if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
    throw new Error('Remote wallet endpoints must use HTTPS');
  }
  if (url.username || url.password) throw new Error('Base URLs must not contain credentials');
  if (url.search || url.hash) throw new Error('Base URLs must not contain a query or fragment');
  return url.toString().replace(/\/$/, '');
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function jsonRequest(body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  };
}

async function walletJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const object = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const error = new Error(typeof object['message'] === 'string'
      ? object['message']
      : `Prepaid wallet request failed with HTTP ${response.status}`);
    Object.assign(error, {
      name: 'PrepaidWalletApiError',
      status: response.status,
      code: object['code'],
      requestId: object['requestId'],
    });
    throw error;
  }
  return body as T;
}
