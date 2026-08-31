import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import type { TxSql } from '../db/client.js';
import {
  newPrepaidWalletId,
  newWalletAssignmentId,
  newWalletLedgerEntryId,
  newWalletReloadRequestId,
  newWalletReservationId,
  newWalletTransactionId,
} from './ids.js';
import {
  signWalletAuthorizationToken,
  verifyWalletAuthorizationToken,
  type WalletAuthorizationPayload,
} from './crypto.js';
import { emitEvent, type EventType } from './events.js';
import {
  WalletPolicyDecisionError,
  WalletSpendPolicyError,
  approvedPolicyIdsForPayment,
  consumeWalletPaymentApproval,
  createWalletPaymentApproval,
  evaluateWalletSpendPolicies,
  mapWalletPaymentApproval,
  recordWalletPolicyDecision,
  type WalletPaymentPolicyContext,
} from './wallet-spend-policy.js';

type Sql = ReturnType<typeof postgres>;

const MAX_ATOMIC_DIGITS = 78;
const MAX_ATOMIC_VALUE = (10n ** BigInt(MAX_ATOMIC_DIGITS)) - 1n;
const AUTHORIZATION_LIFETIME_SECONDS = 300;
const MAX_TEXT = 256;
const MAX_RESOURCE = 2048;
const NETWORK_PATTERN = /^[-a-z0-9]{3,8}:[-_A-Za-z0-9]{1,32}$/;
const SCOPE_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export class PrepaidWalletError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PrepaidWalletError';
  }
}

export interface CreateWalletInput {
  name: string;
  custodyMode: 'sandbox_ledger' | 'external';
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

export interface AssignWalletInput {
  walletId: string;
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

export interface ReservePaymentInput {
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

export interface AgentWalletIdentity {
  developerId: string;
  principalId: string;
  agentId: string;
  grantId: string;
  accessTokenJti: string;
  scopes: string[];
}

export interface PaymentRequirementsBinding {
  amount: string;
  asset: string;
  network: string;
  recipient: string;
  resource: string;
  scope: string;
  maxTimeoutSeconds: number;
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

export interface SettlementResult {
  success: true;
  transaction: string;
  network: string;
  payer: string;
  amount: string;
}

export function atomicAmount(value: unknown, field: string, allowZero = false): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > MAX_ATOMIC_DIGITS) {
    throw new PrepaidWalletError(400, 'INVALID_AMOUNT', `${field} must be an integer string in atomic units`);
  }
  const canonical = value.replace(/^0+(?=\d)/, '');
  if (!allowZero && canonical === '0') {
    throw new PrepaidWalletError(400, 'INVALID_AMOUNT', `${field} must be greater than zero`);
  }
  return canonical;
}

export function validateNetwork(value: unknown): string {
  if (typeof value !== 'string' || !NETWORK_PATTERN.test(value)) {
    throw new PrepaidWalletError(400, 'INVALID_NETWORK', 'network must be a CAIP-2 identifier');
  }
  return value;
}

function boundedText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${field} must contain 1 to ${max} characters`);
  }
  return value.trim();
}

function stringList(value: unknown, field: string, maxItems = 100): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems
      || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > MAX_TEXT)
      || new Set(value).size !== value.length) {
    throw new PrepaidWalletError(400, 'INVALID_REQUEST', `${field} must be a unique string array with at most ${maxItems} entries`);
  }
  return value as string[];
}

function validateScope(value: unknown): string {
  const scope = boundedText(value, 'scope');
  if (!SCOPE_PATTERN.test(scope)) {
    throw new PrepaidWalletError(400, 'INVALID_SCOPE', 'scope is not a valid OAuth scope token');
  }
  return scope;
}

export function validateResource(value: unknown): string {
  const resource = boundedText(value, 'resource', MAX_RESOURCE);
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    throw new PrepaidWalletError(400, 'INVALID_RESOURCE', 'resource must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new PrepaidWalletError(400, 'INVALID_RESOURCE', 'resource must be an absolute HTTP(S) URL without credentials or a fragment');
  }
  const hostname = url.hostname.toLowerCase();
  const loopback = hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.startsWith('127.')
    || hostname === '::1'
    || hostname === '[::1]';
  if (url.protocol === 'http:' && !loopback) {
    throw new PrepaidWalletError(400, 'INSECURE_RESOURCE', 'remote prepaid-wallet resources must use HTTPS');
  }
  return resource;
}

function validateResourceOrigin(value: unknown): string {
  const resource = validateResource(value);
  const url = new URL(resource);
  if (url.pathname !== '/' || url.search) {
    throw new PrepaidWalletError(400, 'INVALID_RESOURCE_ORIGIN', 'allowedResourceOrigins entries must be origins without paths or queries');
  }
  return url.origin;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertBalanceCapacity(current: unknown, increment: string): void {
  if (BigInt(String(current)) + BigInt(increment) > MAX_ATOMIC_VALUE) {
    throw new PrepaidWalletError(409, 'WALLET_BALANCE_LIMIT_EXCEEDED', 'Wallet balance would exceed the supported atomic-unit range');
  }
}

async function assertReloadControls(
  tx: TxSql,
  wallet: Record<string, unknown>,
  increment: string,
): Promise<void> {
  const available = BigInt(String(wallet['available_amount']));
  const reserved = BigInt(String(wallet['reserved_amount'] ?? '0'));
  const amount = BigInt(increment);
  const currentBalance = available + reserved;
  assertBalanceCapacity(currentBalance.toString(), increment);

  const maxBalance = wallet['max_balance'] === null || wallet['max_balance'] === undefined
    ? null
    : BigInt(String(wallet['max_balance']));
  if (maxBalance !== null && currentBalance + amount > maxBalance) {
    throw new PrepaidWalletError(409, 'WALLET_MAX_BALANCE_EXCEEDED', 'Reload would exceed the wallet maximum balance');
  }

  const maxReloadAmount = wallet['max_reload_amount'] === null || wallet['max_reload_amount'] === undefined
    ? null
    : BigInt(String(wallet['max_reload_amount']));
  if (maxReloadAmount !== null && amount > maxReloadAmount) {
    throw new PrepaidWalletError(409, 'WALLET_RELOAD_AMOUNT_EXCEEDED', 'Reload amount exceeds the wallet per-reload limit');
  }

  const periodSeconds = wallet['reload_period_seconds'] === null || wallet['reload_period_seconds'] === undefined
    ? null
    : Number(wallet['reload_period_seconds']);
  const cumulativeLimit = wallet['reload_cumulative_limit'] === null || wallet['reload_cumulative_limit'] === undefined
    ? null
    : BigInt(String(wallet['reload_cumulative_limit']));
  const countLimit = wallet['reload_count_limit'] === null || wallet['reload_count_limit'] === undefined
    ? null
    : Number(wallet['reload_count_limit']);
  if (periodSeconds === null || (cumulativeLimit === null && countLimit === null)) return;

  const usage = await tx`
    SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
    FROM wallet_reload_requests
    WHERE wallet_id = ${(wallet['control_wallet_id'] ?? wallet['id']) as string}
      AND status = 'funded'
      AND funded_at >= NOW() - make_interval(secs => ${periodSeconds})
  `;
  const fundedAmount = BigInt(String(usage[0]?.['amount'] ?? '0'));
  const fundedCount = Number(usage[0]?.['count'] ?? 0);
  if (cumulativeLimit !== null && fundedAmount + amount > cumulativeLimit) {
    throw new PrepaidWalletError(409, 'WALLET_RELOAD_CUMULATIVE_LIMIT_EXCEEDED', 'Reload would exceed the wallet cumulative funding limit');
  }
  if (countLimit !== null && fundedCount + 1 > countLimit) {
    throw new PrepaidWalletError(409, 'WALLET_RELOAD_COUNT_LIMIT_EXCEEDED', 'Reload would exceed the wallet funding-count limit');
  }
}

function canonicalRequest(input: ReservePaymentInput): string {
  return JSON.stringify({
    walletId: input.walletId ?? null,
    amount: input.amount,
    asset: input.asset,
    network: input.network,
    recipient: input.recipient,
    resource: input.resource,
    scope: input.scope,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    merchantId: input.merchantId ?? null,
    purpose: input.purpose ?? null,
    projectId: input.projectId ?? null,
    costCenter: input.costCenter ?? null,
  });
}

function mapWallet(row: Record<string, unknown>) {
  return {
    walletId: row['id'],
    principalId: row['principal_id'],
    name: row['name'],
    custodyMode: row['custody_mode'],
    provider: row['provider'],
    providerWalletId: row['provider_wallet_id'],
    walletAddress: row['wallet_address'],
    network: row['network'],
    asset: row['asset'],
    decimals: row['decimals'],
    availableAmount: String(row['available_amount']),
    reservedAmount: String(row['reserved_amount']),
    lowBalanceThreshold: String(row['low_balance_threshold']),
    maxBalance: row['max_balance'] === null || row['max_balance'] === undefined ? null : String(row['max_balance']),
    maxReloadAmount: row['max_reload_amount'] === null || row['max_reload_amount'] === undefined ? null : String(row['max_reload_amount']),
    reloadCumulativeLimit: row['reload_cumulative_limit'] === null || row['reload_cumulative_limit'] === undefined ? null : String(row['reload_cumulative_limit']),
    reloadPeriodSeconds: row['reload_period_seconds'] === null || row['reload_period_seconds'] === undefined ? null : Number(row['reload_period_seconds']),
    reloadCountLimit: row['reload_count_limit'] === null || row['reload_count_limit'] === undefined ? null : Number(row['reload_count_limit']),
    status: row['status'],
    blockedAt: row['blocked_at'],
    blockedReason: row['blocked_reason'],
    metadata: row['metadata'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}

function mapAssignment(row: Record<string, unknown>) {
  return {
    assignmentId: row['id'],
    walletId: row['wallet_id'],
    agentId: row['agent_id'],
    principalId: row['principal_id'],
    status: row['status'],
    perTransactionLimit: String(row['per_transaction_limit']),
    cumulativeLimit: String(row['cumulative_limit']),
    cumulativePeriodSeconds: row['cumulative_period_seconds'],
    allowedRecipients: row['allowed_recipients'],
    allowedScopes: row['allowed_scopes'],
    allowedResourceOrigins: row['allowed_resource_origins'] ?? [],
    allowAnyRecipient: row['allow_any_recipient'] ?? false,
    allowAnyScope: row['allow_any_scope'] ?? false,
    allowAnyResource: row['allow_any_resource'] ?? false,
    budgetGroup: row['budget_group'] ?? null,
    validFrom: row['valid_from'],
    validUntil: row['valid_until'],
    blockedAt: row['blocked_at'],
    blockedReason: row['blocked_reason'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  };
}

async function safeEvent(developerId: string, type: EventType, data: Record<string, unknown>) {
  await emitEvent(developerId, type, data).catch(() => undefined);
}

export async function createPrepaidWallet(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  raw: CreateWalletInput,
) {
  const name = boundedText(raw.name, 'name', 120);
  if (raw.custodyMode !== 'sandbox_ledger' && raw.custodyMode !== 'external') {
    throw new PrepaidWalletError(400, 'INVALID_CUSTODY_MODE', 'custodyMode must be sandbox_ledger or external');
  }
  const network = validateNetwork(raw.network);
  const asset = boundedText(raw.asset, 'asset');
  const decimals = raw.decimals ?? 6;
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new PrepaidWalletError(400, 'INVALID_DECIMALS', 'decimals must be an integer between 0 and 30');
  }
  const threshold = atomicAmount(raw.lowBalanceThreshold ?? '0', 'lowBalanceThreshold', true);
  const maxBalance = raw.maxBalance === undefined ? null : atomicAmount(raw.maxBalance, 'maxBalance');
  const maxReloadAmount = raw.maxReloadAmount === undefined ? null : atomicAmount(raw.maxReloadAmount, 'maxReloadAmount');
  const reloadCumulativeLimit = raw.reloadCumulativeLimit === undefined
    ? null
    : atomicAmount(raw.reloadCumulativeLimit, 'reloadCumulativeLimit');
  const reloadPeriodSeconds = raw.reloadPeriodSeconds ?? null;
  const reloadCountLimit = raw.reloadCountLimit ?? null;
  if ((reloadCumulativeLimit !== null || reloadCountLimit !== null)
      && (!Number.isSafeInteger(reloadPeriodSeconds) || reloadPeriodSeconds! < 60 || reloadPeriodSeconds! > 31_536_000)) {
    throw new PrepaidWalletError(400, 'INVALID_RELOAD_POLICY', 'reloadPeriodSeconds must be between 60 and 31536000 when a reload velocity limit is set');
  }
  if (reloadCountLimit !== null && (!Number.isSafeInteger(reloadCountLimit) || reloadCountLimit <= 0)) {
    throw new PrepaidWalletError(400, 'INVALID_RELOAD_POLICY', 'reloadCountLimit must be a positive integer');
  }
  const provider = raw.provider === undefined ? undefined : boundedText(raw.provider, 'provider');
  const providerWalletId = raw.providerWalletId === undefined
    ? undefined
    : boundedText(raw.providerWalletId, 'providerWalletId');
  if (raw.custodyMode === 'external' && (!provider || !providerWalletId)) {
    throw new PrepaidWalletError(400, 'EXTERNAL_CUSTODY_REFERENCE_REQUIRED', 'external wallets require provider and providerWalletId');
  }
  const walletAddress = raw.walletAddress === undefined
    ? undefined
    : boundedText(raw.walletAddress, 'walletAddress');
  const id = newPrepaidWalletId();
  try {
    const rows = await sql`
      INSERT INTO prepaid_wallets (
        id, developer_id, principal_id, name, custody_mode, provider,
        provider_wallet_id, wallet_address, network, asset, decimals,
        low_balance_threshold, max_balance, max_reload_amount,
        reload_cumulative_limit, reload_period_seconds, reload_count_limit, metadata
      ) VALUES (
        ${id}, ${owner.developerId}, ${owner.principalId}, ${name}, ${raw.custodyMode},
        ${provider ?? null}, ${providerWalletId ?? null}, ${walletAddress ?? null},
        ${network}, ${asset}, ${decimals}, ${threshold}, ${maxBalance}, ${maxReloadAmount},
        ${reloadCumulativeLimit}, ${reloadPeriodSeconds}, ${reloadCountLimit}, ${JSON.stringify(raw.metadata ?? {})}
      )
      RETURNING *
    `;
    return mapWallet(rows[0] as Record<string, unknown>);
  } catch (error) {
    if (error && typeof error === 'object'
        && (error as { code?: unknown }).code === '23505'
        && (error as { constraint_name?: unknown }).constraint_name === 'uq_prepaid_wallet_provider_ref') {
      throw new PrepaidWalletError(409, 'PROVIDER_WALLET_EXISTS', 'This external provider wallet is already registered');
    }
    throw error;
  }
}

export async function listPrincipalWallets(sql: Sql, owner: { developerId: string; principalId: string }) {
  const rows = await sql`
    SELECT * FROM prepaid_wallets
    WHERE developer_id = ${owner.developerId} AND principal_id = ${owner.principalId}
    ORDER BY created_at DESC
  `;
  return rows.map((row) => mapWallet(row as Record<string, unknown>));
}

export async function listAgentWallets(sql: Sql, identity: AgentWalletIdentity) {
  if (!identity.scopes.includes('wallet:read')) {
    throw new PrepaidWalletError(403, 'INSUFFICIENT_SCOPE', 'wallet:read scope is required');
  }
  const rows = await sql`
    SELECT w.id, w.name, w.network, w.asset, w.decimals,
           w.available_amount, w.reserved_amount, w.low_balance_threshold,
           w.status, w.blocked_at, w.blocked_reason, w.created_at, w.updated_at,
           a.id AS assignment_id, a.status AS assignment_status,
           a.per_transaction_limit, a.cumulative_limit,
           a.cumulative_period_seconds, a.allowed_recipients, a.allowed_scopes,
           a.allowed_resource_origins, a.allow_any_recipient, a.allow_any_scope,
           a.allow_any_resource, a.budget_group,
           a.valid_from, a.valid_until,
           COALESCE(c.all_wallets_blocked, FALSE) AS all_wallets_blocked
    FROM agent_wallet_assignments a
    JOIN prepaid_wallets w ON w.id = a.wallet_id
    LEFT JOIN agent_wallet_controls c
      ON c.developer_id = a.developer_id
     AND c.principal_id = a.principal_id
     AND c.agent_id = a.agent_id
    WHERE a.developer_id = ${identity.developerId}
      AND a.principal_id = ${identity.principalId}
      AND a.agent_id = ${identity.agentId}
      AND a.status <> 'revoked'
    ORDER BY w.created_at ASC
  `;
  return rows.map((row) => ({
    walletId: row['id'],
    name: row['name'],
    network: row['network'],
    asset: row['asset'],
    decimals: row['decimals'],
    availableAmount: String(row['available_amount']),
    reservedAmount: String(row['reserved_amount']),
    lowBalanceThreshold: String(row['low_balance_threshold']),
    status: row['status'],
    blockedAt: row['blocked_at'],
    blockedReason: row['blocked_reason'],
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
    assignmentId: row['assignment_id'],
    assignmentStatus: row['assignment_status'],
    perTransactionLimit: String(row['per_transaction_limit']),
    cumulativeLimit: String(row['cumulative_limit']),
    cumulativePeriodSeconds: row['cumulative_period_seconds'],
    allowedRecipients: row['allowed_recipients'],
    allowedScopes: row['allowed_scopes'],
    allowedResourceOrigins: row['allowed_resource_origins'],
    allowAnyRecipient: row['allow_any_recipient'],
    allowAnyScope: row['allow_any_scope'],
    allowAnyResource: row['allow_any_resource'],
    budgetGroup: row['budget_group'] ?? null,
    validFrom: row['valid_from'],
    validUntil: row['valid_until'],
    allWalletsBlocked: row['all_wallets_blocked'],
  }));
}

export async function assignWallet(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  raw: AssignWalletInput,
) {
  const walletId = boundedText(raw.walletId, 'walletId');
  const agentId = boundedText(raw.agentId, 'agentId');
  const perTransactionLimit = atomicAmount(raw.perTransactionLimit, 'perTransactionLimit');
  const cumulativeLimit = atomicAmount(raw.cumulativeLimit, 'cumulativeLimit');
  if (BigInt(perTransactionLimit) > BigInt(cumulativeLimit)) {
    throw new PrepaidWalletError(400, 'INVALID_POLICY', 'perTransactionLimit must not exceed cumulativeLimit');
  }
  if (!Number.isSafeInteger(raw.cumulativePeriodSeconds)
      || raw.cumulativePeriodSeconds < 60 || raw.cumulativePeriodSeconds > 2_592_000) {
    throw new PrepaidWalletError(400, 'INVALID_POLICY', 'cumulativePeriodSeconds must be between 60 and 2592000');
  }
  const allowedRecipients = stringList(raw.allowedRecipients, 'allowedRecipients');
  const allowedScopes = stringList(raw.allowedScopes, 'allowedScopes');
  const allowedResourceOrigins = stringList(raw.allowedResourceOrigins, 'allowedResourceOrigins')
    .map((value) => validateResourceOrigin(value));
  const allowAnyRecipient = raw.allowAnyRecipient ?? false;
  const allowAnyScope = raw.allowAnyScope ?? false;
  const allowAnyResource = raw.allowAnyResource ?? false;
  if (typeof allowAnyRecipient !== 'boolean' || typeof allowAnyScope !== 'boolean' || typeof allowAnyResource !== 'boolean') {
    throw new PrepaidWalletError(400, 'INVALID_POLICY', 'allowAnyRecipient, allowAnyScope, and allowAnyResource must be booleans');
  }
  if (allowedRecipients.length === 0 && !allowAnyRecipient) {
    throw new PrepaidWalletError(400, 'RECIPIENT_POLICY_REQUIRED', 'Set allowedRecipients or explicitly set allowAnyRecipient');
  }
  if (allowedScopes.length === 0 && !allowAnyScope) {
    throw new PrepaidWalletError(400, 'SCOPE_POLICY_REQUIRED', 'Set allowedScopes or explicitly set allowAnyScope');
  }
  if (allowedResourceOrigins.length === 0 && !allowAnyResource) {
    throw new PrepaidWalletError(400, 'RESOURCE_POLICY_REQUIRED', 'Set allowedResourceOrigins or explicitly set allowAnyResource');
  }
  if ((allowedRecipients.length > 0 && allowAnyRecipient)
      || (allowedScopes.length > 0 && allowAnyScope)
      || (allowedResourceOrigins.length > 0 && allowAnyResource)) {
    throw new PrepaidWalletError(400, 'AMBIGUOUS_POLICY', 'An allowlist and its allow-any flag cannot both be set');
  }
  const budgetGroup = raw.budgetGroup === undefined ? null : boundedText(raw.budgetGroup, 'budgetGroup');
  if (allowedScopes.some((scope) => !SCOPE_PATTERN.test(scope))) {
    throw new PrepaidWalletError(400, 'INVALID_SCOPE', 'allowedScopes contains an invalid OAuth scope token');
  }
  let validUntil: Date | null = null;
  if (raw.validUntil !== undefined) {
    validUntil = new Date(raw.validUntil);
    if (Number.isNaN(validUntil.getTime()) || validUntil <= new Date()) {
      throw new PrepaidWalletError(400, 'INVALID_POLICY', 'validUntil must be a future ISO timestamp');
    }
  }

  const id = newWalletAssignmentId();
  let created: Record<string, unknown> | undefined;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const eligible = await tx`
      SELECT w.id
      FROM prepaid_wallets w
      JOIN agents a ON a.id = ${agentId} AND a.developer_id = w.developer_id
      WHERE w.id = ${walletId}
        AND w.developer_id = ${owner.developerId}
        AND w.principal_id = ${owner.principalId}
        AND w.status <> 'closed'
        AND a.status = 'active'
        AND EXISTS (
          SELECT 1 FROM grants g
          WHERE g.agent_id = a.id
            AND g.developer_id = w.developer_id
            AND g.principal_id = w.principal_id
            AND g.status = 'active'
            AND g.expires_at > NOW()
        )
      FOR UPDATE OF w
    `;
    if (eligible.length === 0) {
      throw new PrepaidWalletError(404, 'WALLET_OR_AGENT_NOT_ELIGIBLE', 'Wallet and active principal grant were not found');
    }
    const rows = await tx`
      INSERT INTO agent_wallet_assignments (
        id, wallet_id, developer_id, principal_id, agent_id,
        per_transaction_limit, cumulative_limit, cumulative_period_seconds,
        allowed_recipients, allowed_scopes, allowed_resource_origins,
        allow_any_recipient, allow_any_scope, allow_any_resource, budget_group, valid_until
      ) VALUES (
        ${id}, ${walletId}, ${owner.developerId}, ${owner.principalId}, ${agentId},
        ${perTransactionLimit}, ${cumulativeLimit}, ${raw.cumulativePeriodSeconds},
        ${allowedRecipients}, ${allowedScopes}, ${allowedResourceOrigins},
        ${allowAnyRecipient}, ${allowAnyScope}, ${allowAnyResource}, ${budgetGroup}, ${validUntil}
      )
      ON CONFLICT (wallet_id, principal_id, agent_id) DO UPDATE SET
        status = 'active',
        per_transaction_limit = EXCLUDED.per_transaction_limit,
        cumulative_limit = EXCLUDED.cumulative_limit,
        cumulative_period_seconds = EXCLUDED.cumulative_period_seconds,
        allowed_recipients = EXCLUDED.allowed_recipients,
        allowed_scopes = EXCLUDED.allowed_scopes,
        allowed_resource_origins = EXCLUDED.allowed_resource_origins,
        allow_any_recipient = EXCLUDED.allow_any_recipient,
        allow_any_scope = EXCLUDED.allow_any_scope,
        allow_any_resource = EXCLUDED.allow_any_resource,
        budget_group = EXCLUDED.budget_group,
        valid_from = NOW(),
        valid_until = EXCLUDED.valid_until,
        blocked_at = NULL,
        blocked_reason = NULL,
        updated_at = NOW()
      WHERE agent_wallet_assignments.status <> 'revoked'
      RETURNING *
    `;
    await tx`
      INSERT INTO agent_wallet_controls (developer_id, principal_id, agent_id)
      VALUES (${owner.developerId}, ${owner.principalId}, ${agentId})
      ON CONFLICT (developer_id, principal_id, agent_id) DO NOTHING
    `;
    created = rows[0] as Record<string, unknown>;
    if (created) {
      await releaseReservations(tx, { assignmentId: created['id'] as string }, 'assignment_policy_updated');
    }
  });
  if (!created) {
    throw new PrepaidWalletError(409, 'ASSIGNMENT_REVOKED', 'A revoked wallet assignment cannot be reactivated');
  }
  return mapAssignment(created);
}

async function releaseReservations(
  tx: TxSql,
  predicate: {
    reservationId?: string;
    walletId?: string;
    assignmentId?: string;
    developerId?: string;
    principalId?: string;
    agentId?: string;
    grantIds?: string[];
    expiredOnly?: boolean;
  },
  reason: string,
): Promise<number> {
  const targetWallets = await tx`
    SELECT DISTINCT wallet_id
    FROM wallet_payment_reservations
    WHERE status = 'reserved'
      AND (${predicate.reservationId ?? null}::text IS NULL OR id = ${predicate.reservationId ?? null})
      AND (${predicate.walletId ?? null}::text IS NULL OR wallet_id = ${predicate.walletId ?? null})
      AND (${predicate.assignmentId ?? null}::text IS NULL OR assignment_id = ${predicate.assignmentId ?? null})
      AND (${predicate.developerId ?? null}::text IS NULL OR developer_id = ${predicate.developerId ?? null})
      AND (${predicate.principalId ?? null}::text IS NULL OR principal_id = ${predicate.principalId ?? null})
      AND (${predicate.agentId ?? null}::text IS NULL OR agent_id = ${predicate.agentId ?? null})
      AND (${predicate.grantIds ?? null}::text[] IS NULL OR grant_id = ANY(${predicate.grantIds ?? null}::text[]))
      AND (${predicate.expiredOnly ?? false}::boolean = FALSE OR expires_at <= NOW())
    ORDER BY wallet_id
  `;
  const walletIds = targetWallets.map((row) => row['wallet_id'] as string);
  if (walletIds.length === 0) return 0;
  await tx`
    SELECT id FROM prepaid_wallets
    WHERE id = ANY(${walletIds}::text[])
    ORDER BY id
    FOR UPDATE
  `;
  const rows = await tx`
    UPDATE wallet_payment_reservations
    SET status = ${predicate.expiredOnly ? 'expired' : 'released'},
        released_at = NOW(), release_reason = ${reason}, updated_at = NOW()
    WHERE status = 'reserved'
      AND (${predicate.reservationId ?? null}::text IS NULL OR id = ${predicate.reservationId ?? null})
      AND (${predicate.walletId ?? null}::text IS NULL OR wallet_id = ${predicate.walletId ?? null})
      AND (${predicate.assignmentId ?? null}::text IS NULL OR assignment_id = ${predicate.assignmentId ?? null})
      AND (${predicate.developerId ?? null}::text IS NULL OR developer_id = ${predicate.developerId ?? null})
      AND (${predicate.principalId ?? null}::text IS NULL OR principal_id = ${predicate.principalId ?? null})
      AND (${predicate.agentId ?? null}::text IS NULL OR agent_id = ${predicate.agentId ?? null})
      AND (${predicate.grantIds ?? null}::text[] IS NULL OR grant_id = ANY(${predicate.grantIds ?? null}::text[]))
      AND (${predicate.expiredOnly ?? false}::boolean = FALSE OR expires_at <= NOW())
    RETURNING id, wallet_id, developer_id, principal_id, amount
  `;
  const byWallet = new Map<string, { amount: bigint; developerId: string; principalId: string; ids: string[] }>();
  for (const row of rows) {
    const walletId = row['wallet_id'] as string;
    const current = byWallet.get(walletId) ?? {
      amount: 0n,
      developerId: row['developer_id'] as string,
      principalId: row['principal_id'] as string,
      ids: [],
    };
    current.amount += BigInt(String(row['amount']));
    current.ids.push(row['id'] as string);
    byWallet.set(walletId, current);
  }
  for (const [walletId, released] of byWallet) {
    const wallets = await tx`
      UPDATE prepaid_wallets
      SET available_amount = available_amount + ${released.amount.toString()},
          reserved_amount = reserved_amount - ${released.amount.toString()},
          updated_at = NOW()
      WHERE id = ${walletId} AND reserved_amount >= ${released.amount.toString()}
      RETURNING available_amount, reserved_amount
    `;
    const wallet = wallets[0];
    if (!wallet) throw new Error('Wallet reservation balance invariant failed during release');
    await tx`
      INSERT INTO wallet_ledger_entries (
        id, wallet_id, developer_id, principal_id, entry_type, amount,
        available_after, reserved_after, metadata
      ) VALUES (
        ${newWalletLedgerEntryId()}, ${walletId}, ${released.developerId}, ${released.principalId},
        ${predicate.expiredOnly ? 'expiry_release' : 'release'}, ${released.amount.toString()},
        ${String(wallet['available_amount'])}, ${String(wallet['reserved_amount'])},
        ${JSON.stringify({ reason, reservationIds: released.ids })}
      )
    `;
  }
  return rows.length;
}

export async function applyWalletSpendPolicyMutation<T>(
  sql: Sql,
  actor: { developerId: string; principalId: string | null },
  mutation: (tx: TxSql) => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`wallet-policy:${actor.developerId}`}, 21))`;
    result = await mutation(tx);
    await releaseReservations(tx, {
      developerId: actor.developerId,
      ...(actor.principalId !== null ? { principalId: actor.principalId } : {}),
    }, 'layered_spend_policy_changed');
  });
  return result!;
}

async function lockActiveAgentWalletControl(
  tx: TxSql,
  identity: { developerId: string; principalId: string; agentId: string },
): Promise<void> {
  await tx`
    INSERT INTO agent_wallet_controls (developer_id, principal_id, agent_id)
    VALUES (${identity.developerId}, ${identity.principalId}, ${identity.agentId})
    ON CONFLICT (developer_id, principal_id, agent_id) DO NOTHING
  `;
  const rows = await tx`
    SELECT all_wallets_blocked
    FROM agent_wallet_controls
    WHERE developer_id = ${identity.developerId}
      AND principal_id = ${identity.principalId}
      AND agent_id = ${identity.agentId}
    FOR SHARE
  `;
  if (!rows[0] || rows[0]['all_wallets_blocked'] === true) {
    throw new PrepaidWalletError(403, 'WALLET_BLOCKED', 'All prepaid wallets are blocked for this agent');
  }
}

export async function releaseExpiredWalletReservations(sql: Sql): Promise<void> {
  await sql.begin(async (_tx) => {
    await releaseReservations(_tx as unknown as TxSql, { expiredOnly: true }, 'authorization_expired');
  });
}

export async function releaseWalletReservationsForGrants(
  tx: TxSql,
  developerId: string,
  grantIds: string[],
): Promise<void> {
  if (grantIds.length === 0) return;
  await releaseReservations(tx, { developerId, grantIds }, 'oauth_grant_revoked');
}

export async function setAssignmentStatus(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  assignmentId: string,
  status: 'active' | 'blocked' | 'revoked',
  reason?: string,
) {
  const boundedReason = status === 'active'
    ? undefined
    : boundedText(reason ?? 'principal action', 'reason');
  let updated: Record<string, unknown> | undefined;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      UPDATE agent_wallet_assignments
      SET status = ${status},
          blocked_at = ${status === 'active' ? null : new Date()},
          blocked_reason = ${status === 'active' ? null : boundedReason ?? null},
          updated_at = NOW()
      WHERE id = ${assignmentId}
        AND developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
        AND status <> 'revoked'
      RETURNING *
    `;
    if (!rows[0]) {
      const existing = await tx`
        SELECT status FROM agent_wallet_assignments
        WHERE id = ${assignmentId}
          AND developer_id = ${owner.developerId}
          AND principal_id = ${owner.principalId}
      `;
      if (existing[0]?.['status'] === 'revoked') {
        throw new PrepaidWalletError(409, 'ASSIGNMENT_REVOKED', 'A revoked wallet assignment cannot be changed');
      }
      throw new PrepaidWalletError(404, 'ASSIGNMENT_NOT_FOUND', 'Wallet assignment not found');
    }
    updated = rows[0] as Record<string, unknown>;
    if (status !== 'active') {
      await releaseReservations(tx, { assignmentId }, `assignment_${status}`);
    }
  });
  await safeEvent(owner.developerId, status === 'active' ? 'wallet.unblocked' : 'wallet.blocked', {
    walletId: updated!['wallet_id'],
    assignmentId,
    agentId: updated!['agent_id'],
    principalId: owner.principalId,
    status,
    reason: boundedReason,
  });
  return mapAssignment(updated!);
}

export async function setAgentWalletBlock(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  agentId: string,
  blocked: boolean,
  reason?: string,
) {
  const boundedReason = blocked ? boundedText(reason ?? 'principal action', 'reason') : undefined;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const grants = await tx`
      SELECT id FROM grants
      WHERE developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
        AND agent_id = ${agentId}
      LIMIT 1
    `;
    if (!grants[0]) throw new PrepaidWalletError(404, 'AGENT_NOT_FOUND', 'Agent is not associated with this principal');
    await tx`
      INSERT INTO agent_wallet_controls (
        developer_id, principal_id, agent_id, all_wallets_blocked,
        blocked_at, blocked_reason, updated_at
      ) VALUES (
        ${owner.developerId}, ${owner.principalId}, ${agentId}, ${blocked},
        ${blocked ? new Date() : null}, ${blocked ? boundedReason ?? null : null}, NOW()
      )
      ON CONFLICT (developer_id, principal_id, agent_id) DO UPDATE SET
        all_wallets_blocked = EXCLUDED.all_wallets_blocked,
        blocked_at = EXCLUDED.blocked_at,
        blocked_reason = EXCLUDED.blocked_reason,
        updated_at = NOW()
    `;
    if (blocked) {
      await releaseReservations(tx, {
        developerId: owner.developerId,
        principalId: owner.principalId,
        agentId,
      }, 'agent_all_wallets_blocked');
    }
  });
  await safeEvent(owner.developerId, blocked ? 'wallet.blocked' : 'wallet.unblocked', {
    agentId,
    principalId: owner.principalId,
    allWallets: true,
    reason: boundedReason,
  });
  return { agentId, allWalletsBlocked: blocked, reason: blocked ? boundedReason : null };
}

export async function setWalletStatus(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  walletId: string,
  status: 'active' | 'blocked' | 'closed',
  reason?: string,
) {
  const boundedReason = status === 'active'
    ? undefined
    : boundedText(reason ?? 'principal action', 'reason');
  let wallet: Record<string, unknown> | undefined;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      UPDATE prepaid_wallets
      SET status = ${status},
          blocked_at = ${status === 'active' ? null : new Date()},
          blocked_reason = ${status === 'active' ? null : boundedReason ?? null},
          updated_at = NOW()
      WHERE id = ${walletId}
        AND developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
        AND status <> 'closed'
      RETURNING *
    `;
    if (!rows[0]) {
      const existing = await tx`
        SELECT status FROM prepaid_wallets
        WHERE id = ${walletId}
          AND developer_id = ${owner.developerId}
          AND principal_id = ${owner.principalId}
      `;
      if (existing[0]?.['status'] === 'closed') {
        throw new PrepaidWalletError(409, 'WALLET_CLOSED', 'A closed wallet cannot be changed');
      }
      throw new PrepaidWalletError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    }
    wallet = rows[0] as Record<string, unknown>;
    if (status !== 'active') await releaseReservations(tx, { walletId }, `wallet_${status}`);
  });
  await safeEvent(owner.developerId, status === 'active' ? 'wallet.unblocked' : 'wallet.blocked', {
    walletId,
    principalId: owner.principalId,
    status,
    reason: boundedReason,
  });
  return mapWallet(wallet!);
}

function validatedReserveInput(raw: ReservePaymentInput): ReservePaymentInput {
  const amount = atomicAmount(raw.amount, 'amount');
  const asset = boundedText(raw.asset, 'asset');
  const network = validateNetwork(raw.network);
  const recipient = boundedText(raw.recipient, 'recipient');
  const resource = validateResource(raw.resource);
  const scope = validateScope(raw.scope);
  const idempotencyKey = boundedText(raw.idempotencyKey, 'idempotencyKey');
  if (!Number.isSafeInteger(raw.maxTimeoutSeconds)
      || raw.maxTimeoutSeconds < 1 || raw.maxTimeoutSeconds > AUTHORIZATION_LIFETIME_SECONDS) {
    throw new PrepaidWalletError(400, 'INVALID_TIMEOUT', `maxTimeoutSeconds must be between 1 and ${AUTHORIZATION_LIFETIME_SECONDS}`);
  }
  if (idempotencyKey.length < 16) {
    throw new PrepaidWalletError(400, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must contain at least 16 characters');
  }
  return {
    ...(raw.walletId ? { walletId: boundedText(raw.walletId, 'walletId') } : {}),
    amount, asset, network, recipient, resource, scope,
    maxTimeoutSeconds: raw.maxTimeoutSeconds,
    idempotencyKey,
    ...(raw.approvalRequestId ? { approvalRequestId: boundedText(raw.approvalRequestId, 'approvalRequestId') } : {}),
    ...(raw.merchantId ? { merchantId: boundedText(raw.merchantId, 'merchantId') } : {}),
    ...(raw.purpose ? { purpose: boundedText(raw.purpose, 'purpose') } : {}),
    ...(raw.projectId ? { projectId: boundedText(raw.projectId, 'projectId') } : {}),
    ...(raw.costCenter ? { costCenter: boundedText(raw.costCenter, 'costCenter') } : {}),
  };
}

export async function reserveWalletPayment(
  sql: Sql,
  identity: AgentWalletIdentity,
  raw: ReservePaymentInput,
): Promise<PrepaidAuthorization | PrepaidApprovalRequired> {
  if (!identity.scopes.includes('wallet:spend')) {
    throw new PrepaidWalletError(403, 'INSUFFICIENT_SCOPE', 'wallet:spend scope is required');
  }
  const input = validatedReserveInput(raw);
  if (!identity.scopes.includes(input.scope)) {
    throw new PrepaidWalletError(403, 'PAYMENT_SCOPE_NOT_GRANTED', 'The OAuth grant does not include the requested payment scope');
  }
  const idempotencyHash = hash(input.idempotencyKey);
  const reservationId = newWalletReservationId();
  const authorizationId = randomUUID();
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + input.maxTimeoutSeconds;
  const expiresAt = new Date(expiresAtSeconds * 1000);
  let result: Omit<PrepaidAuthorization, 'authorization'> | undefined;
  let authorizationClaims: WalletAuthorizationPayload | undefined;
  let createdReservation = false;
  let lowBalanceThreshold = '0';
  let decisionError: WalletPolicyDecisionError | undefined;

  try {
    await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`wallet-policy:${identity.developerId}`}, 21))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${identity.developerId}:${identity.agentId}`}, 13))`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${identity.developerId}:${identity.principalId}:${identity.agentId}:${idempotencyHash}`}, 11))`;
    const authority = await tx`
      SELECT g.id
      FROM grants g
      JOIN grant_tokens gt ON gt.grant_id = g.id AND gt.jti = ${identity.accessTokenJti}
      JOIN agents ag ON ag.id = g.agent_id AND ag.developer_id = g.developer_id
      WHERE g.id = ${identity.grantId}
        AND g.developer_id = ${identity.developerId}
        AND g.principal_id = ${identity.principalId}
        AND g.agent_id = ${identity.agentId}
        AND g.status = 'active'
        AND g.expires_at > NOW()
        AND gt.is_revoked = FALSE
        AND gt.expires_at > NOW()
        AND ag.status = 'active'
      FOR SHARE OF g, gt, ag
    `;
    if (!authority[0]) {
      throw new PrepaidWalletError(401, 'AGENT_AUTHORIZATION_REVOKED', 'The agent grant or access token is no longer active');
    }
    await lockActiveAgentWalletControl(tx, identity);
    const priorRows = await tx`
      SELECT wallet_id
      FROM wallet_payment_reservations
      WHERE developer_id = ${identity.developerId}
        AND principal_id = ${identity.principalId}
        AND agent_id = ${identity.agentId}
        AND idempotency_key_hash = ${idempotencyHash}
      LIMIT 1
      FOR UPDATE
    `;
    const priorWalletId = priorRows[0]?.['wallet_id'] as string | undefined;
    if (priorWalletId && input.walletId && priorWalletId !== input.walletId) {
      throw new PrepaidWalletError(409, 'IDEMPOTENCY_CONFLICT', 'idempotencyKey is already bound to another wallet');
    }
    const candidates = await tx`
      SELECT a.id
      FROM agent_wallet_assignments a
      JOIN prepaid_wallets w ON w.id = a.wallet_id
      WHERE a.developer_id = ${identity.developerId}
        AND a.principal_id = ${identity.principalId}
        AND a.agent_id = ${identity.agentId}
        AND (${input.walletId ?? null}::text IS NULL OR a.wallet_id = ${input.walletId ?? null})
        AND (${priorWalletId ?? null}::text IS NULL OR a.wallet_id = ${priorWalletId ?? null})
      ORDER BY
        CASE WHEN a.wallet_id = ${priorWalletId ?? null} THEN 0 ELSE 1 END,
        w.created_at ASC, a.created_at ASC
    `;
    if (candidates.length === 0) {
      throw new PrepaidWalletError(404, 'NO_ASSIGNED_WALLET', 'No prepaid wallet is assigned to this agent');
    }

    let lastPolicyError: PrepaidWalletError | WalletPolicyDecisionError | undefined;
    for (const candidate of candidates) {
      const assignmentId = candidate['id'] as string;
      const lockedAssignments = await tx`
        SELECT id
        FROM agent_wallet_assignments
        WHERE id = ${assignmentId}
        FOR UPDATE
      `;
      if (!lockedAssignments[0]) continue;
      const rows = await tx`
        SELECT a.*, w.status AS wallet_status, w.custody_mode, w.network AS wallet_network,
               w.asset AS wallet_asset, w.available_amount, w.reserved_amount,
               w.low_balance_threshold, w.wallet_address, w.provider_wallet_id,
               COALESCE(c.all_wallets_blocked, FALSE) AS all_wallets_blocked
        FROM agent_wallet_assignments a
        JOIN prepaid_wallets w ON w.id = a.wallet_id
        LEFT JOIN agent_wallet_controls c
          ON c.developer_id = a.developer_id
         AND c.principal_id = a.principal_id
         AND c.agent_id = a.agent_id
        WHERE a.id = ${assignmentId}
        FOR UPDATE OF w
      `;
      const row = rows[0] as Record<string, unknown> | undefined;
      if (!row) continue;
      try {
        const requestHash = hash(canonicalRequest({
          ...input,
          walletId: row['wallet_id'] as string,
        }));
        if (row['wallet_status'] !== 'active' || row['status'] !== 'active' || row['all_wallets_blocked'] === true) {
          throw new PrepaidWalletError(403, 'WALLET_BLOCKED', 'The wallet or assignment is blocked');
        }
        if (row['custody_mode'] !== 'sandbox_ledger') {
          throw new PrepaidWalletError(503, 'CUSTODY_ADAPTER_UNAVAILABLE', 'External custody settlement is not configured');
        }
        if (new Date(row['valid_from'] as string) > new Date()
            || (row['valid_until'] && new Date(row['valid_until'] as string) <= new Date())) {
          throw new PrepaidWalletError(403, 'ASSIGNMENT_NOT_CURRENT', 'The wallet assignment is outside its validity interval');
        }
        if (row['wallet_network'] !== input.network || row['wallet_asset'] !== input.asset) {
          throw new PrepaidWalletError(403, 'ASSET_OR_NETWORK_NOT_ALLOWED', 'Payment asset or network does not match the wallet');
        }
        const allowedRecipients = row['allowed_recipients'] as string[];
        if (row['allow_any_recipient'] !== true && !allowedRecipients.includes(input.recipient)) {
          throw new PrepaidWalletError(403, 'RECIPIENT_NOT_ALLOWED', 'Payment recipient is not allowed by wallet policy');
        }
        const allowedScopes = row['allowed_scopes'] as string[];
        if (row['allow_any_scope'] !== true && !allowedScopes.includes(input.scope)) {
          throw new PrepaidWalletError(403, 'SCOPE_NOT_ALLOWED', 'Payment scope is not allowed by wallet policy');
        }
        const allowedResourceOrigins = row['allowed_resource_origins'] as string[];
        if (row['allow_any_resource'] !== true && !allowedResourceOrigins.includes(new URL(input.resource).origin)) {
          throw new PrepaidWalletError(403, 'RESOURCE_NOT_ALLOWED', 'Payment resource origin is not allowed by wallet policy');
        }
        if (BigInt(input.amount) > BigInt(String(row['per_transaction_limit']))) {
          throw new PrepaidWalletError(402, 'PER_TRANSACTION_LIMIT_EXCEEDED', 'Payment exceeds the per-transaction wallet limit');
        }

        await releaseReservations(tx, { walletId: row['wallet_id'] as string, expiredOnly: true }, 'authorization_expired');

        const duplicate = await tx`
          SELECT * FROM wallet_payment_reservations
          WHERE developer_id = ${identity.developerId}
            AND principal_id = ${identity.principalId}
            AND agent_id = ${identity.agentId}
            AND idempotency_key_hash = ${idempotencyHash}
          LIMIT 1
        `;
        if (duplicate[0]) {
          const existing = duplicate[0] as Record<string, unknown>;
          if (existing['request_hash'] !== requestHash) {
            throw new PrepaidWalletError(409, 'IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used with different payment terms');
          }
          if (existing['status'] === 'settled') {
            throw new PrepaidWalletError(409, 'PAYMENT_ALREADY_SETTLED', 'The prior payment authorization is already settled');
          }
          if (existing['status'] !== 'reserved') {
            throw new PrepaidWalletError(409, 'IDEMPOTENCY_EXPIRED', 'The prior payment authorization is no longer usable');
          }
          const [balanceRows, spentRows] = await Promise.all([
            tx`SELECT available_amount FROM prepaid_wallets WHERE id = ${existing['wallet_id'] as string}`,
            tx`
              SELECT COALESCE(SUM(amount), 0) AS spent
              FROM wallet_payment_reservations
              WHERE assignment_id = ${assignmentId}
                AND status IN ('reserved', 'settled')
                AND created_at > NOW() - (${Number(row['cumulative_period_seconds'])} * INTERVAL '1 second')
            `,
          ]);
          const currentSpent = BigInt(String(spentRows[0]?.['spent'] ?? '0'));
          const currentLimit = BigInt(String(row['cumulative_limit']));
          const existingExpiry = new Date(existing['expires_at'] as string);
          authorizationClaims = {
            authorizationId: existing['authorization_jti'] as string,
            reservationId: existing['id'] as string,
            walletId: existing['wallet_id'] as string,
            assignmentId,
            agentId: identity.agentId,
            principalId: identity.principalId,
            developerId: identity.developerId,
            grantId: existing['grant_id'] as string,
            amount: input.amount,
            asset: input.asset,
            network: input.network,
            recipient: input.recipient,
            resource: input.resource,
            scope: input.scope,
            merchantId: existing['merchant_id'] as string | null,
            purpose: existing['purpose'] as string | null,
            projectId: existing['project_id'] as string | null,
            costCenter: existing['cost_center'] as string | null,
            requestHash,
            expiresAt: Math.floor(existingExpiry.getTime() / 1000),
          };
          result = {
            reservationId: existing['id'] as string,
            walletId: existing['wallet_id'] as string,
            assignmentId,
            amount: input.amount,
            asset: input.asset,
            network: input.network,
            recipient: input.recipient,
            expiresAt: existingExpiry.toISOString(),
            remainingAvailable: String(balanceRows[0]?.['available_amount'] ?? row['available_amount']),
            remainingCumulative: (currentLimit > currentSpent ? currentLimit - currentSpent : 0n).toString(),
            policyDecisionId: existing['policy_decision_id'] === null || existing['policy_decision_id'] === undefined
              ? null
              : String(existing['policy_decision_id']),
          };
          lowBalanceThreshold = String(row['low_balance_threshold']);
          break;
        }

        const spentRows = await tx`
          SELECT COALESCE(SUM(amount), 0) AS spent
          FROM wallet_payment_reservations
          WHERE assignment_id = ${assignmentId}
            AND status IN ('reserved', 'settled')
            AND created_at > NOW() - (${Number(row['cumulative_period_seconds'])} * INTERVAL '1 second')
        `;
        const alreadySpent = BigInt(String(spentRows[0]?.['spent'] ?? '0'));
        const cumulativeLimit = BigInt(String(row['cumulative_limit']));
        if (alreadySpent + BigInt(input.amount) > cumulativeLimit) {
          throw new PrepaidWalletError(402, 'CUMULATIVE_LIMIT_EXCEEDED', 'Payment exceeds the rolling cumulative wallet limit');
        }

        const policyContext: WalletPaymentPolicyContext = {
          developerId: identity.developerId,
          principalId: identity.principalId,
          agentId: identity.agentId,
          grantId: identity.grantId,
          walletId: row['wallet_id'] as string,
          assignmentId,
          budgetGroup: row['budget_group'] as string | null,
          requestHash,
          amount: input.amount,
          asset: input.asset,
          network: input.network,
          recipient: input.recipient,
          resource: input.resource,
          scope: input.scope,
          merchantId: input.merchantId ?? null,
          purpose: input.purpose ?? null,
          projectId: input.projectId ?? null,
          costCenter: input.costCenter ?? null,
        };
        let approvedPolicyIds: Set<string>;
        try {
          approvedPolicyIds = await approvedPolicyIdsForPayment(tx, policyContext, input.approvalRequestId ?? null);
        } catch (error) {
          if (error instanceof WalletSpendPolicyError) {
            throw new PrepaidWalletError(error.statusCode, error.code, error.message);
          }
          throw error;
        }
        const policyEvaluation = await evaluateWalletSpendPolicies(tx, policyContext, approvedPolicyIds);
        if (policyEvaluation.decision === 'denied') {
          throw new WalletPolicyDecisionError(402, 'LAYERED_SPEND_POLICY_DENIED', 'Payment was denied by a layered Grantex spend policy', policyContext, policyEvaluation);
        }
        if (policyEvaluation.decision === 'approval_required') {
          throw new WalletPolicyDecisionError(409, 'PAYMENT_APPROVAL_REQUIRED', 'Principal approval is required for this payment', policyContext, policyEvaluation);
        }

        const walletRows = await tx`
          UPDATE prepaid_wallets
          SET available_amount = available_amount - ${input.amount},
              reserved_amount = reserved_amount + ${input.amount},
              updated_at = NOW()
          WHERE id = ${row['wallet_id'] as string}
            AND status = 'active'
            AND available_amount >= ${input.amount}
          RETURNING available_amount, reserved_amount
        `;
        const wallet = walletRows[0];
        if (!wallet) {
          throw new PrepaidWalletError(402, 'INSUFFICIENT_WALLET_FUNDS', 'The prepaid wallet does not have enough available funds');
        }
        await tx`
          INSERT INTO wallet_payment_reservations (
            id, wallet_id, assignment_id, developer_id, principal_id, agent_id,
            grant_id, access_token_jti, authorization_jti, idempotency_key_hash,
            request_hash, amount, asset, network, recipient, resource, scope,
            merchant_id, purpose, project_id, cost_center, resource_origin, expires_at
          ) VALUES (
            ${reservationId}, ${row['wallet_id'] as string}, ${assignmentId},
            ${identity.developerId}, ${identity.principalId}, ${identity.agentId},
            ${identity.grantId}, ${identity.accessTokenJti}, ${authorizationId},
            ${idempotencyHash}, ${requestHash}, ${input.amount}, ${input.asset},
            ${input.network}, ${input.recipient}, ${input.resource}, ${input.scope},
            ${input.merchantId ?? null}, ${input.purpose ?? null}, ${input.projectId ?? null},
            ${input.costCenter ?? null}, ${new URL(input.resource).origin}, ${expiresAt}
          )
        `;
        const policyDecisionId = await recordWalletPolicyDecision(tx, policyContext, policyEvaluation, { reservationId });
        await tx`UPDATE wallet_payment_reservations SET policy_decision_id = ${policyDecisionId} WHERE id = ${reservationId}`;
        await consumeWalletPaymentApproval(tx, input.approvalRequestId ?? null, reservationId);
        authorizationClaims = {
          authorizationId,
          reservationId,
          walletId: row['wallet_id'] as string,
          assignmentId,
          agentId: identity.agentId,
          principalId: identity.principalId,
          developerId: identity.developerId,
          grantId: identity.grantId,
          amount: input.amount,
          asset: input.asset,
          network: input.network,
          recipient: input.recipient,
          resource: input.resource,
          scope: input.scope,
          merchantId: input.merchantId ?? null,
          purpose: input.purpose ?? null,
          projectId: input.projectId ?? null,
          costCenter: input.costCenter ?? null,
          requestHash,
          expiresAt: expiresAtSeconds,
        };
        result = {
          reservationId,
          walletId: row['wallet_id'] as string,
          assignmentId,
          amount: input.amount,
          asset: input.asset,
          network: input.network,
          recipient: input.recipient,
          expiresAt: expiresAt.toISOString(),
          remainingAvailable: String(wallet['available_amount']),
          remainingCumulative: (cumulativeLimit - alreadySpent - BigInt(input.amount)).toString(),
          policyDecisionId,
        };
        createdReservation = true;
        lowBalanceThreshold = String(row['low_balance_threshold']);
        break;
      } catch (error) {
        if (!(error instanceof PrepaidWalletError) && !(error instanceof WalletPolicyDecisionError)) throw error;
        lastPolicyError = error;
        if (input.walletId) throw error;
      }
    }
    if (!result || !authorizationClaims) {
      throw lastPolicyError ?? new PrepaidWalletError(402, 'NO_ELIGIBLE_WALLET', 'No assigned wallet can authorize this payment');
    }
    });
  } catch (error) {
    if (error instanceof WalletPolicyDecisionError) decisionError = error;
    else throw error;
  }

  if (decisionError) {
    if (decisionError.result.decision === 'approval_required') {
      const approval = await createWalletPaymentApproval(sql, decisionError.context, decisionError.result);
      await safeEvent(identity.developerId, 'wallet.payment.approval_required', {
        approvalRequestId: approval.approvalRequestId,
        walletId: approval.walletId,
        agentId: identity.agentId,
        principalId: identity.principalId,
        amount: approval.amount,
        asset: approval.asset,
        policyIds: approval.policyIds,
        expiresAt: approval.expiresAt,
      });
      return {
        status: 'approval_required',
        approvalRequestId: String(approval.approvalRequestId),
        walletId: String(approval.walletId),
        assignmentId: String(approval.assignmentId),
        policyIds: approval.policyIds as string[],
        expiresAt: new Date(approval.expiresAt as string).toISOString(),
      };
    }
    await recordWalletPolicyDecision(sql, decisionError.context, decisionError.result);
    await safeEvent(identity.developerId, 'wallet.payment.denied', {
      walletId: decisionError.context.walletId,
      agentId: identity.agentId,
      principalId: identity.principalId,
      amount: decisionError.context.amount,
      asset: decisionError.context.asset,
      policyIds: decisionError.result.matchedPolicyIds,
    });
    throw new PrepaidWalletError(decisionError.statusCode, decisionError.code, decisionError.message);
  }

  const authorization = await signWalletAuthorizationToken(authorizationClaims!);
  if (createdReservation) {
    await safeEvent(identity.developerId, 'wallet.payment.reserved', {
      reservationId: result!.reservationId,
      walletId: result!.walletId,
      agentId: identity.agentId,
      principalId: identity.principalId,
      amount: input.amount,
      asset: input.asset,
    });
    if (BigInt(result!.remainingAvailable) <= BigInt(lowBalanceThreshold)) {
      await safeEvent(identity.developerId, 'wallet.low_balance', {
        walletId: result!.walletId,
        agentId: identity.agentId,
        remainingAvailable: result!.remainingAvailable,
        lowBalanceThreshold,
      });
    }
  }
  return { authorization, ...result! };
}

function bindingHash(binding: PaymentRequirementsBinding, walletId?: string): string {
  return hash(canonicalRequest({
    ...binding,
    ...(walletId ? { walletId } : {}),
    idempotencyKey: 'not-hashed',
  }));
}

function validatedBinding(raw: PaymentRequirementsBinding): PaymentRequirementsBinding {
  if (!Number.isSafeInteger(raw.maxTimeoutSeconds)
      || raw.maxTimeoutSeconds < 1 || raw.maxTimeoutSeconds > AUTHORIZATION_LIFETIME_SECONDS) {
    throw new PrepaidWalletError(400, 'INVALID_TIMEOUT', `maxTimeoutSeconds must be between 1 and ${AUTHORIZATION_LIFETIME_SECONDS}`);
  }
  return {
    amount: atomicAmount(raw.amount, 'amount'),
    asset: boundedText(raw.asset, 'asset'),
    network: validateNetwork(raw.network),
    recipient: boundedText(raw.recipient, 'recipient'),
    resource: validateResource(raw.resource),
    scope: validateScope(raw.scope),
    maxTimeoutSeconds: raw.maxTimeoutSeconds,
    ...(raw.merchantId ? { merchantId: boundedText(raw.merchantId, 'merchantId') } : {}),
    ...(raw.purpose ? { purpose: boundedText(raw.purpose, 'purpose') } : {}),
    ...(raw.projectId ? { projectId: boundedText(raw.projectId, 'projectId') } : {}),
    ...(raw.costCenter ? { costCenter: boundedText(raw.costCenter, 'costCenter') } : {}),
  };
}

function assertAuthorizationBinding(
  claims: WalletAuthorizationPayload,
  binding: PaymentRequirementsBinding,
) {
  const expected = bindingHash(binding, claims.walletId);
  if (claims.requestHash !== expected) {
    throw new PrepaidWalletError(400, 'PAYMENT_REQUIREMENTS_MISMATCH', 'Payment requirements do not match the wallet authorization');
  }
}

export async function verifyWalletPayment(
  sql: Sql,
  token: string,
  binding: PaymentRequirementsBinding,
) {
  binding = validatedBinding(binding);
  const claims = await verifyWalletAuthorizationToken(token).catch(() => {
    throw new PrepaidWalletError(401, 'INVALID_WALLET_AUTHORIZATION', 'Wallet authorization is invalid or expired');
  });
  assertAuthorizationBinding(claims, binding);
  const rows = await sql`
    SELECT r.status, r.expires_at, w.status AS wallet_status,
           w.wallet_address, w.provider_wallet_id,
           a.status AS assignment_status,
           g.status AS grant_status, g.expires_at AS grant_expires_at,
           gt.is_revoked AS access_token_revoked, gt.expires_at AS access_token_expires_at,
           COALESCE(c.all_wallets_blocked, FALSE) AS all_wallets_blocked
    FROM wallet_payment_reservations r
    JOIN prepaid_wallets w ON w.id = r.wallet_id
    JOIN agent_wallet_assignments a ON a.id = r.assignment_id
    JOIN grants g ON g.id = r.grant_id
    JOIN grant_tokens gt ON gt.jti = r.access_token_jti AND gt.grant_id = r.grant_id
    LEFT JOIN agent_wallet_controls c
      ON c.developer_id = r.developer_id
     AND c.principal_id = r.principal_id
     AND c.agent_id = r.agent_id
    WHERE r.id = ${claims.reservationId}
      AND r.authorization_jti = ${claims.authorizationId}
      AND r.wallet_id = ${claims.walletId}
      AND r.assignment_id = ${claims.assignmentId}
      AND r.agent_id = ${claims.agentId}
      AND r.principal_id = ${claims.principalId}
      AND r.developer_id = ${claims.developerId}
      AND r.grant_id = ${claims.grantId}
      AND r.amount = ${claims.amount}
      AND r.asset = ${claims.asset}
      AND r.network = ${claims.network}
      AND r.recipient = ${claims.recipient}
      AND r.resource = ${claims.resource}
      AND r.scope = ${claims.scope}
      AND r.merchant_id IS NOT DISTINCT FROM ${claims.merchantId ?? null}
      AND r.purpose IS NOT DISTINCT FROM ${claims.purpose ?? null}
      AND r.project_id IS NOT DISTINCT FROM ${claims.projectId ?? null}
      AND r.cost_center IS NOT DISTINCT FROM ${claims.costCenter ?? null}
      AND r.request_hash = ${claims.requestHash}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || row['status'] !== 'reserved') {
    throw new PrepaidWalletError(409, 'RESERVATION_NOT_ACTIVE', 'Wallet reservation is not active');
  }
  if (new Date(row['expires_at'] as string) <= new Date()) {
    throw new PrepaidWalletError(409, 'RESERVATION_EXPIRED', 'Wallet reservation has expired');
  }
  if (row['grant_status'] !== 'active'
      || row['access_token_revoked'] === true
      || new Date(row['grant_expires_at'] as string) <= new Date()
      || new Date(row['access_token_expires_at'] as string) <= new Date()) {
    throw new PrepaidWalletError(403, 'AGENT_AUTHORIZATION_REVOKED', 'The agent grant or access token is no longer active');
  }
  if (row['wallet_status'] !== 'active' || row['assignment_status'] !== 'active'
      || row['all_wallets_blocked'] === true) {
    throw new PrepaidWalletError(403, 'WALLET_BLOCKED', 'Wallet use was blocked by the principal');
  }
  return {
    valid: true as const,
    payer: (row['wallet_address'] as string | null)
      ?? (row['provider_wallet_id'] as string | null)
      ?? claims.walletId,
    reservationId: claims.reservationId,
  };
}

export async function settleWalletPayment(
  sql: Sql,
  token: string,
  binding: PaymentRequirementsBinding,
): Promise<SettlementResult> {
  binding = validatedBinding(binding);
  const claims = await verifyWalletAuthorizationToken(token).catch(() => {
    throw new PrepaidWalletError(401, 'INVALID_WALLET_AUTHORIZATION', 'Wallet authorization is invalid or expired');
  });
  assertAuthorizationBinding(claims, binding);
  let settlement: SettlementResult | undefined;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`wallet-policy:${claims.developerId}`}, 21))`;
    const authority = await tx`
      SELECT g.id, ar.status AS reservation_status
      FROM grants g
      JOIN grant_tokens gt ON gt.grant_id = g.id
      JOIN wallet_payment_reservations ar
        ON ar.grant_id = g.id AND ar.access_token_jti = gt.jti
      WHERE ar.id = ${claims.reservationId}
        AND g.id = ${claims.grantId}
        AND (ar.status = 'settled' OR (
          g.status = 'active'
          AND g.expires_at > NOW()
          AND gt.is_revoked = FALSE
          AND gt.expires_at > NOW()
        ))
      FOR SHARE OF g, gt
    `;
    if (!authority[0]) {
      throw new PrepaidWalletError(403, 'AGENT_AUTHORIZATION_REVOKED', 'The agent grant or access token is no longer active');
    }
    if (authority[0]['reservation_status'] !== 'settled') {
      await lockActiveAgentWalletControl(tx, claims);
    }
    const lockedAssignments = await tx`
      SELECT id
      FROM agent_wallet_assignments
      WHERE id = ${claims.assignmentId}
      FOR UPDATE
    `;
    if (!lockedAssignments[0]) {
      throw new PrepaidWalletError(404, 'RESERVATION_NOT_FOUND', 'Wallet reservation was not found');
    }
    const lockedWallets = await tx`
      SELECT id
      FROM prepaid_wallets
      WHERE id = ${claims.walletId}
      FOR UPDATE
    `;
    if (!lockedWallets[0]) {
      throw new PrepaidWalletError(404, 'RESERVATION_NOT_FOUND', 'Wallet reservation was not found');
    }
    const rows = await tx`
      SELECT r.*, w.status AS wallet_status, w.custody_mode,
             w.wallet_address, w.provider_wallet_id, w.available_amount, w.reserved_amount,
             a.status AS assignment_status,
             g.status AS grant_status, g.expires_at AS grant_expires_at,
             gt.is_revoked AS access_token_revoked, gt.expires_at AS access_token_expires_at,
             COALESCE(c.all_wallets_blocked, FALSE) AS all_wallets_blocked
      FROM wallet_payment_reservations r
      JOIN prepaid_wallets w ON w.id = r.wallet_id
      JOIN agent_wallet_assignments a ON a.id = r.assignment_id
      JOIN grants g ON g.id = r.grant_id
      JOIN grant_tokens gt ON gt.jti = r.access_token_jti AND gt.grant_id = r.grant_id
      LEFT JOIN agent_wallet_controls c
        ON c.developer_id = r.developer_id
       AND c.principal_id = r.principal_id
       AND c.agent_id = r.agent_id
      WHERE r.id = ${claims.reservationId}
        AND r.authorization_jti = ${claims.authorizationId}
        AND r.wallet_id = ${claims.walletId}
        AND r.assignment_id = ${claims.assignmentId}
        AND r.agent_id = ${claims.agentId}
        AND r.principal_id = ${claims.principalId}
        AND r.developer_id = ${claims.developerId}
        AND r.grant_id = ${claims.grantId}
        AND r.amount = ${claims.amount}
        AND r.asset = ${claims.asset}
        AND r.network = ${claims.network}
        AND r.recipient = ${claims.recipient}
        AND r.resource = ${claims.resource}
        AND r.scope = ${claims.scope}
        AND r.merchant_id IS NOT DISTINCT FROM ${claims.merchantId ?? null}
        AND r.purpose IS NOT DISTINCT FROM ${claims.purpose ?? null}
        AND r.project_id IS NOT DISTINCT FROM ${claims.projectId ?? null}
        AND r.cost_center IS NOT DISTINCT FROM ${claims.costCenter ?? null}
        AND r.request_hash = ${claims.requestHash}
      FOR UPDATE OF r
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new PrepaidWalletError(404, 'RESERVATION_NOT_FOUND', 'Wallet reservation was not found');
    const payer = (row['wallet_address'] as string | null)
      ?? (row['provider_wallet_id'] as string | null)
      ?? claims.walletId;
    if (row['status'] === 'settled') {
      settlement = {
        success: true,
        transaction: row['transaction_id'] as string,
        network: claims.network,
        payer,
        amount: claims.amount,
      };
      return;
    }
    if (row['status'] !== 'reserved') {
      throw new PrepaidWalletError(409, 'RESERVATION_NOT_ACTIVE', 'Wallet reservation is not active');
    }
    if (new Date(row['expires_at'] as string) <= new Date()) {
      throw new PrepaidWalletError(409, 'RESERVATION_EXPIRED', 'Wallet reservation has expired');
    }
    if (row['grant_status'] !== 'active'
        || row['access_token_revoked'] === true
        || new Date(row['grant_expires_at'] as string) <= new Date()
        || new Date(row['access_token_expires_at'] as string) <= new Date()) {
      throw new PrepaidWalletError(403, 'AGENT_AUTHORIZATION_REVOKED', 'The agent grant or access token is no longer active');
    }
    if (row['wallet_status'] !== 'active' || row['assignment_status'] !== 'active'
        || row['all_wallets_blocked'] === true) {
      throw new PrepaidWalletError(403, 'WALLET_BLOCKED', 'Wallet use was blocked by the principal');
    }
    if (row['custody_mode'] !== 'sandbox_ledger') {
      throw new PrepaidWalletError(503, 'CUSTODY_ADAPTER_UNAVAILABLE', 'External custody settlement is not configured');
    }
    const transaction = newWalletTransactionId();
    const walletRows = await tx`
      UPDATE prepaid_wallets
      SET reserved_amount = reserved_amount - ${claims.amount}, updated_at = NOW()
      WHERE id = ${claims.walletId} AND reserved_amount >= ${claims.amount}
      RETURNING available_amount, reserved_amount
    `;
    const wallet = walletRows[0];
    if (!wallet) throw new Error('Wallet reservation balance invariant failed during settlement');
    await tx`
      UPDATE wallet_payment_reservations
      SET status = 'settled', transaction_id = ${transaction}, settled_at = NOW(), updated_at = NOW()
      WHERE id = ${claims.reservationId}
    `;
    await tx`
      INSERT INTO wallet_ledger_entries (
        id, wallet_id, developer_id, principal_id, entry_type, amount,
        available_after, reserved_after, reservation_id, metadata
      ) VALUES (
        ${newWalletLedgerEntryId()}, ${claims.walletId}, ${claims.developerId},
        ${claims.principalId}, 'settlement', ${claims.amount},
        ${String(wallet['available_amount'])}, ${String(wallet['reserved_amount'])},
        ${claims.reservationId},
        ${JSON.stringify({ transaction, recipient: claims.recipient, resource: claims.resource, scope: claims.scope })}
      )
    `;
    settlement = { success: true, transaction, network: claims.network, payer, amount: claims.amount };
  });
  await safeEvent(claims.developerId, 'wallet.payment.settled', {
    reservationId: claims.reservationId,
    walletId: claims.walletId,
    agentId: claims.agentId,
    transaction: settlement!.transaction,
    amount: claims.amount,
    asset: claims.asset,
  });
  return settlement!;
}

export async function requestWalletReload(
  sql: Sql,
  identity: AgentWalletIdentity,
  walletId: string,
  requestedAmount: string,
  idempotencyKeyValue: string,
  reason?: string,
) {
  if (!identity.scopes.includes('wallet:reload:request')) {
    throw new PrepaidWalletError(403, 'INSUFFICIENT_SCOPE', 'wallet:reload:request scope is required');
  }
  const amount = atomicAmount(requestedAmount, 'amount');
  const idempotencyKey = boundedText(idempotencyKeyValue, 'idempotencyKey');
  if (idempotencyKey.length < 16) {
    throw new PrepaidWalletError(400, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must contain at least 16 characters');
  }
  const idempotencyHash = hash(idempotencyKey);
  const boundedReason = reason === undefined ? undefined : boundedText(reason, 'reason', 500);
  const id = newWalletReloadRequestId();
  let reload: Record<string, unknown> | undefined;
  let created = false;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await lockActiveAgentWalletControl(tx, identity);
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${identity.developerId}:${identity.principalId}:${identity.agentId}:${idempotencyHash}`}, 15))`;
    const replay = await tx`
      SELECT *
      FROM wallet_reload_requests
      WHERE developer_id = ${identity.developerId}
        AND principal_id = ${identity.principalId}
        AND agent_id = ${identity.agentId}
        AND requested_by = 'agent'
        AND idempotency_key_hash = ${idempotencyHash}
      LIMIT 1
      FOR UPDATE
    `;
    if (replay[0]) {
      const sameReason = (replay[0]['reason'] ?? undefined) === boundedReason;
      if (replay[0]['wallet_id'] !== walletId
          || String(replay[0]['amount']) !== amount
          || !sameReason) {
        throw new PrepaidWalletError(409, 'IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for another reload request');
      }
      reload = replay[0] as Record<string, unknown>;
      return;
    }
    const assignments = await tx`
      SELECT id
      FROM agent_wallet_assignments
      WHERE wallet_id = ${walletId}
        AND developer_id = ${identity.developerId}
        AND principal_id = ${identity.principalId}
        AND agent_id = ${identity.agentId}
      FOR UPDATE
    `;
    if (!assignments[0]) {
      throw new PrepaidWalletError(409, 'RELOAD_NOT_AVAILABLE', 'Wallet is not eligible for an agent reload request');
    }
    const eligible = await tx`
      SELECT a.id AS assignment_id, w.id, w.available_amount, w.reserved_amount,
             w.max_balance, w.max_reload_amount, w.reload_cumulative_limit,
             w.reload_period_seconds, w.reload_count_limit
      FROM agent_wallet_assignments a
      JOIN prepaid_wallets w ON w.id = a.wallet_id
      LEFT JOIN agent_wallet_controls c
        ON c.developer_id = a.developer_id
       AND c.principal_id = a.principal_id
       AND c.agent_id = a.agent_id
      WHERE w.id = ${walletId}
        AND a.developer_id = ${identity.developerId}
        AND a.principal_id = ${identity.principalId}
        AND a.agent_id = ${identity.agentId}
        AND a.status = 'active'
        AND w.status = 'active'
        AND COALESCE(c.all_wallets_blocked, FALSE) = FALSE
        AND w.available_amount <= w.low_balance_threshold
      FOR UPDATE OF w
    `;
    if (!eligible[0]) {
      throw new PrepaidWalletError(409, 'RELOAD_NOT_AVAILABLE', 'Wallet is not eligible for an agent reload request');
    }
    await assertReloadControls(tx, eligible[0] as Record<string, unknown>, amount);
    const pending = await tx`
      SELECT * FROM wallet_reload_requests
      WHERE wallet_id = ${walletId}
        AND agent_id = ${identity.agentId}
        AND status = 'pending'
      LIMIT 1
      FOR UPDATE
    `;
    if (pending[0]) {
      throw new PrepaidWalletError(409, 'RELOAD_REQUEST_CONFLICT', 'A pending reload request already exists under another idempotency key');
    }
    const rows = await tx`
      INSERT INTO wallet_reload_requests (
        id, wallet_id, assignment_id, developer_id, principal_id,
        agent_id, amount, reason, requested_by, idempotency_key_hash
      ) VALUES (
        ${id}, ${walletId}, ${eligible[0]['assignment_id'] as string},
        ${identity.developerId}, ${identity.principalId}, ${identity.agentId},
        ${amount}, ${boundedReason ?? null}, 'agent', ${idempotencyHash}
      )
      RETURNING *
    `;
    reload = rows[0] as Record<string, unknown>;
    created = true;
  });
  if (!reload) throw new Error('Reload request was not created');
  if (created) {
    await safeEvent(identity.developerId, 'wallet.reload.requested', {
      reloadRequestId: id, walletId, agentId: identity.agentId, principalId: identity.principalId, amount,
    });
  }
  return mapReload(reload);
}

function mapReload(row: Record<string, unknown>) {
  return {
    reloadRequestId: row['id'],
    walletId: row['wallet_id'],
    assignmentId: row['assignment_id'],
    agentId: row['agent_id'],
    amount: String(row['amount']),
    reason: row['reason'],
    status: row['status'],
    requestedBy: row['requested_by'],
    externalReference: row['external_reference'],
    createdAt: row['created_at'],
    decidedAt: row['decided_at'],
    fundedAt: row['funded_at'],
  };
}

export async function decideReloadRequest(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  requestId: string,
  decision: 'approved' | 'rejected',
) {
  let reload: Record<string, unknown> | undefined;
  let changed = false;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      SELECT * FROM wallet_reload_requests
      WHERE id = ${requestId}
        AND developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
      FOR UPDATE
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new PrepaidWalletError(404, 'RELOAD_REQUEST_NOT_FOUND', 'Reload request not found');
    if (row['status'] === decision) {
      reload = row;
      return;
    }
    if (row['status'] !== 'pending') {
      throw new PrepaidWalletError(409, 'RELOAD_DECISION_CONFLICT', 'Reload request already has a different terminal decision');
    }
    const updated = await tx`
      UPDATE wallet_reload_requests
      SET status = ${decision}, decided_at = NOW(), updated_at = NOW()
      WHERE id = ${requestId} AND status = 'pending'
      RETURNING *
    `;
    reload = updated[0] as Record<string, unknown>;
    changed = true;
  });
  if (changed) {
    await safeEvent(owner.developerId, decision === 'approved' ? 'wallet.reload.approved' : 'wallet.reload.rejected', {
      reloadRequestId: requestId,
      walletId: reload!['wallet_id'],
      principalId: owner.principalId,
    });
  }
  return mapReload(reload!);
}

export async function createPrincipalReload(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  walletId: string,
  amountValue: string,
  idempotencyKeyValue: string,
  externalReference?: string,
) {
  const amount = atomicAmount(amountValue, 'amount');
  const idempotencyKey = boundedText(idempotencyKeyValue, 'idempotencyKey');
  if (idempotencyKey.length < 16) {
    throw new PrepaidWalletError(400, 'INVALID_IDEMPOTENCY_KEY', 'idempotencyKey must contain at least 16 characters');
  }
  const idempotencyHash = hash(idempotencyKey);
  const boundedReference = externalReference === undefined
    ? undefined
    : boundedText(externalReference, 'externalReference');
  const requestId = newWalletReloadRequestId();
  let reload: Record<string, unknown> | undefined;
  let created = false;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${owner.developerId}:${owner.principalId}:${idempotencyHash}`}, 12))`;
    const wallets = await tx`
      SELECT * FROM prepaid_wallets
      WHERE id = ${walletId}
        AND developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
        AND status <> 'closed'
      FOR UPDATE
    `;
    const wallet = wallets[0] as Record<string, unknown> | undefined;
    if (!wallet) throw new PrepaidWalletError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    if (wallet['custody_mode'] !== 'sandbox_ledger') {
      throw new PrepaidWalletError(503, 'CUSTODY_ADAPTER_UNAVAILABLE', 'External custody funding is not configured');
    }
    const existing = await tx`
      SELECT * FROM wallet_reload_requests
      WHERE developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
        AND requested_by = 'principal'
        AND idempotency_key_hash = ${idempotencyHash}
      LIMIT 1
      FOR UPDATE
    `;
    if (existing[0]) {
      if (existing[0]['wallet_id'] !== walletId
          || String(existing[0]['amount']) !== amount
          || (boundedReference !== undefined && existing[0]['external_reference'] !== boundedReference)) {
        throw new PrepaidWalletError(409, 'IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for another principal reload');
      }
      reload = existing[0] as Record<string, unknown>;
      return;
    }
    if (boundedReference !== undefined) {
      const referenceRows = await tx`
        SELECT id FROM wallet_reload_requests
        WHERE wallet_id = ${walletId} AND external_reference = ${boundedReference}
        LIMIT 1
      `;
      if (referenceRows[0]) {
        throw new PrepaidWalletError(409, 'EXTERNAL_REFERENCE_CONFLICT', 'externalReference was already used for this wallet');
      }
    }
    await assertReloadControls(tx, wallet, amount);
    const reference = boundedReference
      ?? (wallet['custody_mode'] === 'sandbox_ledger' ? `sandbox:${requestId}` : undefined);
    if (!reference) {
      throw new PrepaidWalletError(400, 'EXTERNAL_REFERENCE_REQUIRED', 'External wallet reloads require a provider funding reference');
    }
    const inserted = await tx`
      INSERT INTO wallet_reload_requests (
        id, wallet_id, developer_id, principal_id, amount, status,
        requested_by, decided_at, funded_at, external_reference, idempotency_key_hash
      ) VALUES (
        ${requestId}, ${walletId}, ${owner.developerId}, ${owner.principalId},
        ${amount}, 'funded', 'principal', NOW(), NOW(), ${reference}, ${idempotencyHash}
      )
      RETURNING *
    `;
    const walletRows = await tx`
      UPDATE prepaid_wallets
      SET available_amount = available_amount + ${amount}, updated_at = NOW()
      WHERE id = ${walletId}
      RETURNING available_amount, reserved_amount
    `;
    await tx`
      INSERT INTO wallet_ledger_entries (
        id, wallet_id, developer_id, principal_id, entry_type, amount,
        available_after, reserved_after, reload_request_id, external_reference
      ) VALUES (
        ${newWalletLedgerEntryId()}, ${walletId}, ${owner.developerId}, ${owner.principalId},
        'credit', ${amount}, ${String(walletRows[0]!['available_amount'])},
        ${String(walletRows[0]!['reserved_amount'])}, ${requestId}, ${reference}
      )
    `;
    reload = inserted[0] as Record<string, unknown>;
    created = true;
  });
  if (created) {
    await safeEvent(owner.developerId, 'wallet.reloaded', {
      reloadRequestId: requestId, walletId, principalId: owner.principalId, amount,
    });
  }
  return mapReload(reload!);
}

export async function fundApprovedReload(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  requestId: string,
  externalReference?: string,
) {
  const boundedReference = externalReference === undefined
    ? undefined
    : boundedText(externalReference, 'externalReference');
  let reload: Record<string, unknown> | undefined;
  let funded = false;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const targetRows = await tx`
      SELECT wallet_id
      FROM wallet_reload_requests
      WHERE id = ${requestId}
        AND developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
    `;
    if (!targetRows[0]) {
      throw new PrepaidWalletError(404, 'RELOAD_REQUEST_NOT_FOUND', 'Reload request not found');
    }
    const lockedWallets = await tx`
      SELECT id
      FROM prepaid_wallets
      WHERE id = ${targetRows[0]['wallet_id'] as string}
      FOR UPDATE
    `;
    if (!lockedWallets[0]) {
      throw new PrepaidWalletError(404, 'RELOAD_REQUEST_NOT_FOUND', 'Reload request not found');
    }
    const rows = await tx`
      SELECT rr.*, w.id AS control_wallet_id, w.custody_mode, w.available_amount, w.reserved_amount,
             w.max_balance, w.max_reload_amount, w.reload_cumulative_limit,
             w.reload_period_seconds, w.reload_count_limit
      FROM wallet_reload_requests rr
      JOIN prepaid_wallets w ON w.id = rr.wallet_id
      WHERE rr.id = ${requestId}
        AND rr.developer_id = ${owner.developerId}
        AND rr.principal_id = ${owner.principalId}
      FOR UPDATE OF rr
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new PrepaidWalletError(404, 'RELOAD_REQUEST_NOT_FOUND', 'Reload request not found');
    }
    if (row['status'] === 'funded') {
      if (boundedReference !== undefined && row['external_reference'] !== boundedReference) {
        throw new PrepaidWalletError(409, 'IDEMPOTENCY_CONFLICT', 'Reload request was already funded with another external reference');
      }
      reload = row;
      return;
    }
    if (row['status'] !== 'approved') {
      throw new PrepaidWalletError(409, 'RELOAD_NOT_APPROVED', 'Reload request is not approved for funding');
    }
    if (row['custody_mode'] !== 'sandbox_ledger') {
      throw new PrepaidWalletError(503, 'CUSTODY_ADAPTER_UNAVAILABLE', 'External custody funding is not configured');
    }
    await assertReloadControls(tx, row, String(row['amount']));
    const reference = boundedReference
      ?? (row['custody_mode'] === 'sandbox_ledger' ? `sandbox:${requestId}` : undefined);
    if (!reference) {
      throw new PrepaidWalletError(400, 'EXTERNAL_REFERENCE_REQUIRED', 'External wallet reloads require a provider funding reference');
    }
    const referenceRows = await tx`
      SELECT id FROM wallet_reload_requests
      WHERE wallet_id = ${row['wallet_id'] as string}
        AND external_reference = ${reference}
        AND id <> ${requestId}
      LIMIT 1
    `;
    if (referenceRows[0]) {
      throw new PrepaidWalletError(409, 'EXTERNAL_REFERENCE_CONFLICT', 'externalReference was already used for this wallet');
    }
    const walletRows = await tx`
      UPDATE prepaid_wallets
      SET available_amount = available_amount + ${String(row['amount'])}, updated_at = NOW()
      WHERE id = ${row['wallet_id'] as string} AND status <> 'closed'
      RETURNING available_amount, reserved_amount
    `;
    if (!walletRows[0]) throw new PrepaidWalletError(409, 'WALLET_CLOSED', 'Closed wallets cannot be funded');
    const updated = await tx`
      UPDATE wallet_reload_requests
      SET status = 'funded', funded_at = NOW(), external_reference = ${reference}, updated_at = NOW()
      WHERE id = ${requestId} AND status = 'approved'
      RETURNING *
    `;
    await tx`
      INSERT INTO wallet_ledger_entries (
        id, wallet_id, developer_id, principal_id, entry_type, amount,
        available_after, reserved_after, reload_request_id, external_reference
      ) VALUES (
        ${newWalletLedgerEntryId()}, ${row['wallet_id'] as string}, ${owner.developerId},
        ${owner.principalId}, 'credit', ${String(row['amount'])},
        ${String(walletRows[0]['available_amount'])}, ${String(walletRows[0]['reserved_amount'])},
        ${requestId}, ${reference}
      )
    `;
    reload = updated[0] as Record<string, unknown>;
    funded = true;
  });
  if (funded) {
    await safeEvent(owner.developerId, 'wallet.reloaded', {
      reloadRequestId: requestId, walletId: reload!['wallet_id'], principalId: owner.principalId,
      amount: String(reload!['amount']),
    });
  }
  return mapReload(reload!);
}

export async function releaseReservationByPrincipal(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  reservationId: string,
  reason: string,
) {
  let released = 0;
  await sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    released = await releaseReservations(tx, {
      reservationId,
      developerId: owner.developerId,
      principalId: owner.principalId,
    }, boundedText(reason, 'reason'));
  });
  if (released === 0) throw new PrepaidWalletError(404, 'RESERVATION_NOT_FOUND', 'Active reservation not found');
  return { reservationId, status: 'released' as const };
}

export async function listWalletActivity(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  walletId: string,
) {
  const owned = await sql`
    SELECT id FROM prepaid_wallets
    WHERE id = ${walletId} AND developer_id = ${owner.developerId} AND principal_id = ${owner.principalId}
  `;
  if (!owned[0]) throw new PrepaidWalletError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
  const [assignments, reservations, reloads, ledger, policyDecisions, approvals] = await Promise.all([
    sql`SELECT * FROM agent_wallet_assignments WHERE wallet_id = ${walletId} ORDER BY created_at DESC`,
    sql`SELECT id, assignment_id, agent_id, amount, asset, network, recipient, resource, scope, status, transaction_id, expires_at, settled_at, released_at, release_reason, created_at FROM wallet_payment_reservations WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 200`,
    sql`SELECT * FROM wallet_reload_requests WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 200`,
    sql`SELECT id, entry_type, amount, available_after, reserved_after, reservation_id, reload_request_id, external_reference, metadata, created_at FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 200`,
    sql`SELECT id, agent_id, assignment_id, reservation_id, approval_request_id, request_hash, decision, matched_policy_ids, evaluations, created_at FROM wallet_policy_decisions WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 200`,
    sql`SELECT id, agent_id, assignment_id, amount, asset, network, recipient, resource, scope, merchant_id, purpose, project_id, cost_center, policy_ids, status, reason, expires_at, decided_at, consumed_at, reservation_id, created_at, updated_at FROM wallet_payment_approval_requests WHERE wallet_id = ${walletId} ORDER BY created_at DESC LIMIT 200`,
  ]);
  return {
    assignments: assignments.map((row) => mapAssignment(row as Record<string, unknown>)),
    reservations,
    reloadRequests: reloads.map((row) => mapReload(row as Record<string, unknown>)),
    ledger,
    policyDecisions,
    paymentApprovals: approvals.map((row) => mapWalletPaymentApproval(row as Record<string, unknown>)),
  };
}
