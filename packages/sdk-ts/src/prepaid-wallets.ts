import type { OAuthAgentClient } from './oauth-agent.js';

export type PrepaidCustodyMode = 'sandbox_ledger' | 'external';
export type PrepaidWalletStatus = 'active' | 'blocked' | 'closed';
export type WalletAssignmentStatus = 'active' | 'blocked' | 'revoked';

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
  metadata?: Record<string, unknown>;
}

export interface AssignPrepaidWalletParams {
  agentId: string;
  perTransactionLimit: string;
  cumulativeLimit: string;
  cumulativePeriodSeconds: number;
  allowedRecipients?: string[];
  allowedScopes?: string[];
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
}

export interface PrepaidAuthorizationResponse {
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

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.#sessionToken}`);
    headers.set('Accept', 'application/json');
    const response = await fetch(`${this.#baseUrl}${path}`, { ...init, headers });
    return walletJson<T>(response);
  }
}

function normalizeUrl(value: string): string {
  if (!value) throw new Error('A base URL is required');
  const url = new URL(value);
  if (url.search || url.hash) throw new Error('Base URLs must not contain a query or fragment');
  return url.toString().replace(/\/$/, '');
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
