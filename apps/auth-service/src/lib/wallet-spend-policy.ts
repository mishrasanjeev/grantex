import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import type { TxSql } from '../db/client.js';
import {
  newWalletApprovalRequestId,
  newWalletPolicyDecisionId,
  newWalletSpendPolicyId,
} from './ids.js';

type Sql = ReturnType<typeof postgres>;

export type WalletPolicyScope = 'assignment' | 'wallet' | 'agent' | 'group' | 'principal' | 'developer';
export type WalletPolicyEffect = 'limit' | 'deny' | 'require_approval';
export type WalletPolicyWindow = 'per_authorization' | 'rolling' | 'calendar_day' | 'calendar_week' | 'calendar_month' | 'lifetime';
export type WalletPolicyStatus = 'active' | 'disabled' | 'revoked';

export interface WalletSpendPolicyInput {
  name: string;
  description?: string;
  scopeType: WalletPolicyScope;
  scopeId?: string;
  effect: WalletPolicyEffect;
  onExceed?: 'deny' | 'require_approval';
  maxAmount?: string;
  maxCount?: number;
  windowType?: WalletPolicyWindow;
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

export interface WalletPaymentPolicyContext {
  developerId: string;
  principalId: string;
  agentId: string;
  grantId: string;
  walletId: string;
  assignmentId: string;
  budgetGroup: string | null;
  requestHash: string;
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
}

export interface WalletPolicyEvaluation {
  policyId: string;
  name: string;
  version: number;
  effect: WalletPolicyEffect;
  result: 'passed' | 'denied' | 'approval_required';
  consumedAmount: string;
  consumedCount: number;
  proposedAmount: string;
  proposedCount: number;
  maxAmount: string | null;
  maxCount: number | null;
  windowType: WalletPolicyWindow;
  windowSeconds: number | null;
}

export interface WalletPolicyEvaluationResult {
  decision: 'allowed' | 'denied' | 'approval_required';
  matchedPolicyIds: string[];
  requiredApprovalPolicyIds: string[];
  approvalPolicyIds: string[];
  evaluations: WalletPolicyEvaluation[];
}

export class WalletSpendPolicyError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WalletSpendPolicyError';
  }
}

export class WalletPolicyDecisionError extends WalletSpendPolicyError {
  constructor(
    statusCode: number,
    code: string,
    message: string,
    readonly context: WalletPaymentPolicyContext,
    readonly result: WalletPolicyEvaluationResult,
  ) {
    super(statusCode, code, message);
  }
}

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function amount(value: string | undefined, field: string, allowZero = true): string | null {
  if (value === undefined) return null;
  if (!/^(0|[1-9][0-9]{0,77})$/.test(value) || (!allowZero && value === '0')) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', `${field} must be an atomic-unit integer string`);
  }
  return value;
}

function list(value: string[] | undefined, field: string, normalizer?: (item: string) => string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', `${field} must contain at most 200 strings`);
  }
  const values = value.map((item) => normalizer ? normalizer(text(item, field, 500)) : text(item, field, 500));
  return [...new Set(values)].sort();
}

function origin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'resourceOrigins must contain valid absolute origins');
  }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'resourceOrigins must contain origins without credentials, paths, queries, or fragments');
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'remote resource origins must use HTTPS');
  }
  return parsed.origin;
}

function instant(value: string | undefined, field: string): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', `${field} must be an ISO timestamp`);
  }
  return parsed;
}

function validatePolicy(input: WalletSpendPolicyInput) {
  const scopes: WalletPolicyScope[] = ['assignment', 'wallet', 'agent', 'group', 'principal', 'developer'];
  const effects: WalletPolicyEffect[] = ['limit', 'deny', 'require_approval'];
  const windows: WalletPolicyWindow[] = ['per_authorization', 'rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'lifetime'];
  if (!scopes.includes(input.scopeType)) throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'Unsupported scopeType');
  if (!effects.includes(input.effect)) throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'Unsupported effect');
  if (input.onExceed !== undefined && !['deny', 'require_approval'].includes(input.onExceed)) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'onExceed must be deny or require_approval');
  }
  const windowType = input.windowType ?? 'per_authorization';
  if (!windows.includes(windowType)) throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'Unsupported windowType');
  const maxAmount = amount(input.maxAmount, 'maxAmount');
  const maxCount = input.maxCount ?? null;
  if (maxCount !== null && (!Number.isInteger(maxCount) || maxCount < 0 || maxCount > 2_147_483_647)) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'maxCount must be a non-negative integer');
  }
  if (input.effect === 'limit' && maxAmount === null && maxCount === null) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'A limit policy requires maxAmount or maxCount');
  }
  if (windowType === 'rolling' && (!Number.isInteger(input.windowSeconds)
      || input.windowSeconds! < 10 || input.windowSeconds! > 2_678_400)) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'rolling policies require windowSeconds between 10 and 2678400');
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < -100_000 || priority > 100_000) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'priority must be an integer between -100000 and 100000');
  }
  const validFrom = instant(input.validFrom, 'validFrom') ?? new Date();
  const validUntil = instant(input.validUntil, 'validUntil');
  if (validUntil && validUntil <= validFrom) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'validUntil must be later than validFrom');
  }
  return {
    name: text(input.name, 'name', 200),
    description: input.description === undefined ? null : text(input.description, 'description', 1000),
    scopeType: input.scopeType,
    scopeId: input.scopeId === undefined ? null : text(input.scopeId, 'scopeId', 200),
    effect: input.effect,
    onExceed: input.onExceed ?? 'deny',
    maxAmount,
    maxCount,
    windowType,
    windowSeconds: windowType === 'rolling' ? input.windowSeconds! : null,
    recipients: list(input.recipients, 'recipients'),
    resourceOrigins: list(input.resourceOrigins, 'resourceOrigins', origin),
    actionScopes: list(input.actionScopes, 'actionScopes'),
    assets: list(input.assets, 'assets'),
    networks: list(input.networks, 'networks'),
    merchantIds: list(input.merchantIds, 'merchantIds'),
    purposes: list(input.purposes, 'purposes'),
    projectIds: list(input.projectIds, 'projectIds'),
    costCenters: list(input.costCenters, 'costCenters'),
    requireVerifiedMerchant: input.requireVerifiedMerchant ?? false,
    priority,
    validFrom,
    validUntil,
  };
}

function mapPolicy(row: Record<string, unknown>) {
  return {
    policyId: row['id'], developerId: row['developer_id'], principalId: row['principal_id'] ?? null,
    name: row['name'], description: row['description'] ?? null,
    scopeType: row['scope_type'], scopeId: row['scope_id'] ?? null,
    effect: row['effect'], onExceed: row['on_exceed'],
    maxAmount: row['max_amount'] === null ? null : String(row['max_amount']),
    maxCount: row['max_count'] === null ? null : Number(row['max_count']),
    windowType: row['window_type'], windowSeconds: row['window_seconds'] === null ? null : Number(row['window_seconds']),
    recipients: row['recipients'], resourceOrigins: row['resource_origins'], actionScopes: row['action_scopes'],
    assets: row['assets'], networks: row['networks'], merchantIds: row['merchant_ids'], purposes: row['purposes'],
    projectIds: row['project_ids'], costCenters: row['cost_centers'],
    requireVerifiedMerchant: row['require_verified_merchant'], priority: row['priority'], status: row['status'],
    version: row['version'], validFrom: row['valid_from'], validUntil: row['valid_until'] ?? null,
    createdAt: row['created_at'], updatedAt: row['updated_at'],
  };
}

async function assertScopeOwned(sql: Sql | TxSql, developerId: string, principalId: string | null, scopeType: WalletPolicyScope, scopeId: string | null) {
  if (scopeType === 'developer') {
    if (principalId !== null) throw new WalletSpendPolicyError(403, 'SPEND_POLICY_SCOPE_FORBIDDEN', 'Principal sessions cannot create developer-wide policies');
    return;
  }
  if (scopeType === 'principal') {
    if (principalId === null) {
      if (!scopeId) throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'principal policies require scopeId');
      return;
    }
    if (scopeId !== null && scopeId !== principalId) {
      throw new WalletSpendPolicyError(403, 'SPEND_POLICY_SCOPE_FORBIDDEN', 'Principal policy scope must identify the authenticated principal');
    }
    return;
  }
  if (scopeType === 'group') {
    if (!scopeId) throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', 'group policies require scopeId');
    return;
  }
  if (!scopeId) throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY', `${scopeType} policies require scopeId`);
  const rows = scopeType === 'wallet'
    ? await sql`SELECT id FROM prepaid_wallets WHERE id = ${scopeId} AND developer_id = ${developerId} AND (${principalId}::text IS NULL OR principal_id = ${principalId})`
    : scopeType === 'assignment'
      ? await sql`SELECT id FROM agent_wallet_assignments WHERE id = ${scopeId} AND developer_id = ${developerId} AND (${principalId}::text IS NULL OR principal_id = ${principalId})`
      : await sql`SELECT id FROM agents WHERE id = ${scopeId} AND developer_id = ${developerId}`;
  if (!rows[0]) throw new WalletSpendPolicyError(404, 'SPEND_POLICY_SCOPE_NOT_FOUND', 'Policy scope was not found in the authenticated partition');
}

export async function createWalletSpendPolicy(
  sql: Sql | TxSql,
  actor: { developerId: string; principalId: string | null },
  input: WalletSpendPolicyInput,
) {
  const policy = validatePolicy(input);
  if (actor.principalId !== null && policy.scopeType === 'principal' && policy.scopeId === null) {
    policy.scopeId = actor.principalId;
  }
  await assertScopeOwned(sql, actor.developerId, actor.principalId, policy.scopeType, policy.scopeId);
  const id = newWalletSpendPolicyId();
  const rows = await sql`
    INSERT INTO wallet_spend_policies (
      id, developer_id, principal_id, name, description, scope_type, scope_id,
      effect, on_exceed, max_amount, max_count, window_type, window_seconds,
      recipients, resource_origins, action_scopes, assets, networks, merchant_ids,
      purposes, project_ids, cost_centers, require_verified_merchant, priority,
      valid_from, valid_until
    ) VALUES (
      ${id}, ${actor.developerId}, ${actor.principalId}, ${policy.name}, ${policy.description},
      ${policy.scopeType}, ${policy.scopeId}, ${policy.effect}, ${policy.onExceed},
      ${policy.maxAmount}, ${policy.maxCount}, ${policy.windowType}, ${policy.windowSeconds},
      ${policy.recipients}, ${policy.resourceOrigins}, ${policy.actionScopes}, ${policy.assets},
      ${policy.networks}, ${policy.merchantIds}, ${policy.purposes}, ${policy.projectIds},
      ${policy.costCenters}, ${policy.requireVerifiedMerchant}, ${policy.priority},
      ${policy.validFrom}, ${policy.validUntil}
    ) RETURNING *
  `;
  return mapPolicy(rows[0] as Record<string, unknown>);
}

export async function listWalletSpendPolicies(sql: Sql, actor: { developerId: string; principalId: string | null }) {
  const rows = await sql`
    SELECT * FROM wallet_spend_policies
    WHERE developer_id = ${actor.developerId}
      AND (${actor.principalId}::text IS NULL OR principal_id IS NULL OR principal_id = ${actor.principalId})
    ORDER BY priority DESC, created_at ASC
  `;
  return rows.map((row) => mapPolicy(row as Record<string, unknown>));
}

export async function setWalletSpendPolicyStatus(
  sql: Sql | TxSql,
  actor: { developerId: string; principalId: string | null },
  policyId: string,
  status: WalletPolicyStatus,
) {
  if (!['active', 'disabled', 'revoked'].includes(status)) {
    throw new WalletSpendPolicyError(400, 'INVALID_SPEND_POLICY_STATUS', 'status must be active, disabled, or revoked');
  }
  const rows = await sql`
    UPDATE wallet_spend_policies SET
      status = ${status}, version = version + 1, updated_at = NOW()
    WHERE id = ${policyId} AND developer_id = ${actor.developerId}
      AND (${actor.principalId}::text IS NULL OR principal_id = ${actor.principalId})
      AND status <> 'revoked'
    RETURNING *
  `;
  if (!rows[0]) throw new WalletSpendPolicyError(404, 'SPEND_POLICY_NOT_FOUND', 'Spend policy was not found or is terminally revoked');
  return mapPolicy(rows[0] as Record<string, unknown>);
}

function matches(values: unknown, candidate: string | null): boolean {
  const filter = values as string[];
  return filter.length === 0 || (candidate !== null && filter.includes(candidate));
}

function resourceOrigin(resource: string): string | null {
  try { return new URL(resource).origin; } catch { return null; }
}

function windowStart(type: WalletPolicyWindow, seconds: number | null, now: Date): Date | null {
  if (type === 'lifetime' || type === 'per_authorization') return null;
  if (type === 'rolling') return new Date(now.getTime() - (seconds ?? 0) * 1000);
  if (type === 'calendar_day') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (type === 'calendar_week') {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const mondayOffset = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - mondayOffset);
    return start;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function merchantIsVerified(tx: TxSql, merchantId: string | null, resource: string): Promise<boolean> {
  if (!merchantId) return false;
  const rows = await tx`
    SELECT domain FROM trust_registry
    WHERE (id = ${merchantId} OR organization_did = ${merchantId})
      AND trust_level = 'verified' AND verified_at IS NOT NULL
    LIMIT 1
  `;
  const domain = rows[0]?.['domain'];
  if (typeof domain !== 'string') return false;
  try {
    const host = new URL(resource).hostname.toLowerCase();
    const normalized = domain.toLowerCase().replace(/^\.+|\.+$/g, '');
    return host === normalized || host.endsWith(`.${normalized}`);
  } catch {
    return false;
  }
}

async function usageForPolicy(tx: TxSql, row: Record<string, unknown>, context: WalletPaymentPolicyContext, start: Date | null) {
  const scopeType = row['scope_type'] as WalletPolicyScope;
  const scopeId = row['scope_id'] as string | null;
  const rows = await tx`
    SELECT COALESCE(SUM(r.amount), 0) AS amount, COUNT(*) AS count
    FROM wallet_payment_reservations r
    JOIN agent_wallet_assignments a ON a.id = r.assignment_id
    WHERE r.developer_id = ${context.developerId}
      AND r.status IN ('reserved','settled')
      AND (${start}::timestamptz IS NULL OR r.created_at >= ${start})
      AND (${scopeType} <> 'assignment' OR r.assignment_id = ${scopeId})
      AND (${scopeType} <> 'wallet' OR r.wallet_id = ${scopeId})
      AND (${scopeType} <> 'agent' OR r.agent_id = ${scopeId})
      AND (${scopeType} <> 'group' OR a.budget_group = ${scopeId})
      AND (${scopeType} <> 'principal' OR r.principal_id = ${scopeId})
      AND (${scopeType} <> 'developer' OR r.developer_id = ${context.developerId})
      AND (cardinality(${row['recipients'] as string[]}::text[]) = 0 OR r.recipient = ANY(${row['recipients'] as string[]}::text[]))
      AND (cardinality(${row['resource_origins'] as string[]}::text[]) = 0
        OR COALESCE(r.resource_origin, CASE
          WHEN lower(r.resource) LIKE 'https://%'
            THEN regexp_replace(lower(substring(r.resource FROM '(?i)^https?://[^/?#]+')), ':443$', '')
          WHEN lower(r.resource) LIKE 'http://%'
            THEN regexp_replace(lower(substring(r.resource FROM '(?i)^https?://[^/?#]+')), ':80$', '')
          ELSE lower(substring(r.resource FROM '(?i)^https?://[^/?#]+'))
        END)
          = ANY(${row['resource_origins'] as string[]}::text[]))
      AND (cardinality(${row['action_scopes'] as string[]}::text[]) = 0 OR r.scope = ANY(${row['action_scopes'] as string[]}::text[]))
      AND (cardinality(${row['assets'] as string[]}::text[]) = 0 OR r.asset = ANY(${row['assets'] as string[]}::text[]))
      AND (cardinality(${row['networks'] as string[]}::text[]) = 0 OR r.network = ANY(${row['networks'] as string[]}::text[]))
      AND (cardinality(${row['merchant_ids'] as string[]}::text[]) = 0 OR r.merchant_id = ANY(${row['merchant_ids'] as string[]}::text[]))
      AND (cardinality(${row['purposes'] as string[]}::text[]) = 0 OR r.purpose = ANY(${row['purposes'] as string[]}::text[]))
      AND (cardinality(${row['project_ids'] as string[]}::text[]) = 0 OR r.project_id = ANY(${row['project_ids'] as string[]}::text[]))
      AND (cardinality(${row['cost_centers'] as string[]}::text[]) = 0 OR r.cost_center = ANY(${row['cost_centers'] as string[]}::text[]))
  `;
  return { amount: BigInt(String(rows[0]?.['amount'] ?? '0')), count: Number(rows[0]?.['count'] ?? 0) };
}

export async function evaluateWalletSpendPolicies(
  tx: TxSql,
  context: WalletPaymentPolicyContext,
  approvedPolicyIds: ReadonlySet<string> = new Set(),
): Promise<WalletPolicyEvaluationResult> {
  const rows = await tx`
    SELECT * FROM wallet_spend_policies
    WHERE developer_id = ${context.developerId}
      AND status = 'active'
      AND (principal_id IS NULL OR principal_id = ${context.principalId})
      AND valid_from <= NOW() AND (valid_until IS NULL OR valid_until > NOW())
      AND (
        scope_type = 'developer'
        OR (scope_type = 'principal' AND scope_id = ${context.principalId})
        OR (scope_type = 'agent' AND scope_id = ${context.agentId})
        OR (scope_type = 'wallet' AND scope_id = ${context.walletId})
        OR (scope_type = 'assignment' AND scope_id = ${context.assignmentId})
        OR (scope_type = 'group' AND scope_id = ${context.budgetGroup})
      )
    ORDER BY priority DESC, created_at ASC
    FOR UPDATE
  `;
  const originValue = resourceOrigin(context.resource);
  const matched = (rows as Record<string, unknown>[]).filter((row) =>
    matches(row['recipients'], context.recipient)
      && matches(row['resource_origins'], originValue)
      && matches(row['action_scopes'], context.scope)
      && matches(row['assets'], context.asset)
      && matches(row['networks'], context.network)
      && matches(row['merchant_ids'], context.merchantId)
      && matches(row['purposes'], context.purpose)
      && matches(row['project_ids'], context.projectId)
      && matches(row['cost_centers'], context.costCenter));

  const evaluations: WalletPolicyEvaluation[] = [];
  const requiredApprovalPolicyIds: string[] = [];
  const approvalPolicyIds: string[] = [];
  let denied = false;
  for (const row of matched) {
    const policyId = row['id'] as string;
    const effect = row['effect'] as WalletPolicyEffect;
    const type = row['window_type'] as WalletPolicyWindow;
    const seconds = row['window_seconds'] === null ? null : Number(row['window_seconds']);
    const usage = type === 'per_authorization'
      ? { amount: 0n, count: 0 }
      : await usageForPolicy(tx, row, context, windowStart(type, seconds, new Date()));
    const proposedAmount = usage.amount + BigInt(context.amount);
    const proposedCount = usage.count + 1;
    const maxAmount = row['max_amount'] === null ? null : BigInt(String(row['max_amount']));
    const maxCount = row['max_count'] === null ? null : Number(row['max_count']);
    const verified = row['require_verified_merchant'] === true
      ? await merchantIsVerified(tx, context.merchantId, context.resource)
      : true;
    const limitExceeded = effect === 'limit' && (
      (maxAmount !== null && proposedAmount > maxAmount)
      || (maxCount !== null && proposedCount > maxCount)
    );
    const requiresApproval = effect === 'require_approval'
      || (limitExceeded && row['on_exceed'] === 'require_approval');
    if (verified && requiresApproval) requiredApprovalPolicyIds.push(policyId);
    let result: WalletPolicyEvaluation['result'] = 'passed';
    if (!verified || effect === 'deny' || (limitExceeded && row['on_exceed'] === 'deny')) {
      denied = true;
      result = 'denied';
    } else if (requiresApproval && !approvedPolicyIds.has(policyId)) {
      approvalPolicyIds.push(policyId);
      result = 'approval_required';
    }
    evaluations.push({
      policyId, name: String(row['name']), version: Number(row['version']), effect, result,
      consumedAmount: usage.amount.toString(), consumedCount: usage.count,
      proposedAmount: proposedAmount.toString(), proposedCount,
      maxAmount: maxAmount?.toString() ?? null, maxCount,
      windowType: type, windowSeconds: seconds,
    });
  }
  return {
    decision: denied ? 'denied' : approvalPolicyIds.length > 0 ? 'approval_required' : 'allowed',
    matchedPolicyIds: evaluations.map((item) => item.policyId),
    requiredApprovalPolicyIds,
    approvalPolicyIds,
    evaluations,
  };
}

export async function recordWalletPolicyDecision(
  sql: Sql | TxSql,
  context: WalletPaymentPolicyContext,
  result: WalletPolicyEvaluationResult,
  references: { reservationId?: string; approvalRequestId?: string } = {},
): Promise<string> {
  const id = newWalletPolicyDecisionId();
  await sql`
    INSERT INTO wallet_policy_decisions (
      id, developer_id, principal_id, agent_id, wallet_id, assignment_id,
      reservation_id, approval_request_id, request_hash, decision,
      matched_policy_ids, evaluations
    ) VALUES (
      ${id}, ${context.developerId}, ${context.principalId}, ${context.agentId},
      ${context.walletId}, ${context.assignmentId}, ${references.reservationId ?? null},
      ${references.approvalRequestId ?? null}, ${context.requestHash}, ${result.decision},
      ${result.matchedPolicyIds}, ${sql.json(result.evaluations as never)}
    )
  `;
  return id;
}

function approvalHash(context: WalletPaymentPolicyContext): string {
  return createHash('sha256').update(JSON.stringify({
    walletId: context.walletId, assignmentId: context.assignmentId, requestHash: context.requestHash,
    amount: context.amount, asset: context.asset, network: context.network, recipient: context.recipient,
    resource: context.resource, scope: context.scope, merchantId: context.merchantId,
    purpose: context.purpose, projectId: context.projectId, costCenter: context.costCenter,
  })).digest('hex');
}

export async function createWalletPaymentApproval(
  sql: Sql,
  context: WalletPaymentPolicyContext,
  result: WalletPolicyEvaluationResult,
) {
  const effectiveHash = approvalHash(context);
  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.developerId}:${context.principalId}:${context.agentId}:${effectiveHash}`}, 19))`;
    const existing = await tx`
      SELECT * FROM wallet_payment_approval_requests
      WHERE developer_id = ${context.developerId} AND principal_id = ${context.principalId}
        AND agent_id = ${context.agentId} AND request_hash = ${context.requestHash}
        AND status IN ('pending','approved') AND expires_at > NOW()
      LIMIT 1 FOR UPDATE
    `;
    if (existing[0]) {
      const current = existing[0] as Record<string, unknown>;
      const previousPolicyIds = [...(current['policy_ids'] as string[])].sort();
      const requiredPolicyIds = [...result.requiredApprovalPolicyIds].sort();
      if (JSON.stringify(previousPolicyIds) === JSON.stringify(requiredPolicyIds)) {
        return mapWalletPaymentApproval(current);
      }
      await tx`
        UPDATE wallet_payment_approval_requests
        SET status = 'expired',
            reason = 'Spend policy requirements changed before authorization',
            updated_at = NOW()
        WHERE id = ${current['id'] as string}
      `;
    }
    const id = newWalletApprovalRequestId();
    const rows = await tx`
      INSERT INTO wallet_payment_approval_requests (
        id, developer_id, principal_id, agent_id, grant_id, wallet_id, assignment_id,
        request_hash, amount, asset, network, recipient, resource, scope, merchant_id,
        purpose, project_id, cost_center, policy_ids, expires_at
      ) VALUES (
        ${id}, ${context.developerId}, ${context.principalId}, ${context.agentId}, ${context.grantId},
        ${context.walletId}, ${context.assignmentId}, ${context.requestHash}, ${context.amount},
        ${context.asset}, ${context.network}, ${context.recipient}, ${context.resource}, ${context.scope},
        ${context.merchantId}, ${context.purpose}, ${context.projectId}, ${context.costCenter},
        ${result.requiredApprovalPolicyIds}, NOW() + INTERVAL '15 minutes'
      ) RETURNING *
    `;
    const approval = rows[0] as Record<string, unknown>;
    await recordWalletPolicyDecision(tx, context, result, { approvalRequestId: id });
    return mapWalletPaymentApproval(approval);
  });
}

export function mapWalletPaymentApproval(row: Record<string, unknown>) {
  return {
    approvalRequestId: row['id'], walletId: row['wallet_id'], assignmentId: row['assignment_id'],
    agentId: row['agent_id'], amount: String(row['amount']), asset: row['asset'], network: row['network'],
    recipient: row['recipient'], resource: row['resource'], scope: row['scope'], merchantId: row['merchant_id'] ?? null,
    purpose: row['purpose'] ?? null, projectId: row['project_id'] ?? null, costCenter: row['cost_center'] ?? null,
    policyIds: row['policy_ids'], status: row['status'], reason: row['reason'] ?? null,
    expiresAt: row['expires_at'], decidedAt: row['decided_at'] ?? null,
    consumedAt: row['consumed_at'] ?? null, reservationId: row['reservation_id'] ?? null,
    createdAt: row['created_at'], updatedAt: row['updated_at'],
  };
}

export async function listWalletPaymentApprovals(sql: Sql, owner: { developerId: string; principalId: string }) {
  await sql`
    UPDATE wallet_payment_approval_requests SET status = 'expired', updated_at = NOW()
    WHERE developer_id = ${owner.developerId} AND principal_id = ${owner.principalId}
      AND status IN ('pending','approved') AND expires_at <= NOW()
  `;
  const rows = await sql`
    SELECT * FROM wallet_payment_approval_requests
    WHERE developer_id = ${owner.developerId} AND principal_id = ${owner.principalId}
    ORDER BY created_at DESC LIMIT 200
  `;
  return rows.map((row) => mapWalletPaymentApproval(row as Record<string, unknown>));
}

export async function decideWalletPaymentApproval(
  sql: Sql,
  owner: { developerId: string; principalId: string },
  approvalRequestId: string,
  decision: 'approved' | 'rejected',
  reason?: string,
) {
  return sql.begin(async (_tx) => {
    const tx = _tx as unknown as TxSql;
    const rows = await tx`
      SELECT * FROM wallet_payment_approval_requests
      WHERE id = ${approvalRequestId} AND developer_id = ${owner.developerId}
        AND principal_id = ${owner.principalId}
      FOR UPDATE
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new WalletSpendPolicyError(404, 'PAYMENT_APPROVAL_NOT_FOUND', 'Payment approval request was not found');
    if (new Date(row['expires_at'] as string) <= new Date()) {
      await tx`UPDATE wallet_payment_approval_requests SET status = 'expired', updated_at = NOW() WHERE id = ${approvalRequestId}`;
      throw new WalletSpendPolicyError(409, 'PAYMENT_APPROVAL_EXPIRED', 'Payment approval request has expired');
    }
    if (row['status'] === decision) return mapWalletPaymentApproval(row);
    if (row['status'] !== 'pending') {
      throw new WalletSpendPolicyError(409, 'PAYMENT_APPROVAL_DECISION_CONFLICT', 'Payment approval request already has a terminal or different decision');
    }
    const updated = await tx`
      UPDATE wallet_payment_approval_requests SET
        status = ${decision}, reason = ${reason ?? null}, decided_at = NOW(), updated_at = NOW()
      WHERE id = ${approvalRequestId} RETURNING *
    `;
    return mapWalletPaymentApproval(updated[0] as Record<string, unknown>);
  });
}

export async function approvedPolicyIdsForPayment(
  tx: TxSql,
  context: WalletPaymentPolicyContext,
  approvalRequestId: string | null,
): Promise<Set<string>> {
  if (!approvalRequestId) return new Set();
  const rows = await tx`
    SELECT * FROM wallet_payment_approval_requests
    WHERE id = ${approvalRequestId} AND developer_id = ${context.developerId}
      AND principal_id = ${context.principalId} AND agent_id = ${context.agentId}
      AND wallet_id = ${context.walletId} AND assignment_id = ${context.assignmentId}
      AND request_hash = ${context.requestHash} AND status = 'approved'
      AND expires_at > NOW()
    FOR UPDATE
  `;
  if (!rows[0]) throw new WalletSpendPolicyError(409, 'PAYMENT_APPROVAL_INVALID', 'An approved, unexpired request matching these exact payment terms was not found');
  return new Set(rows[0]['policy_ids'] as string[]);
}

export async function consumeWalletPaymentApproval(
  tx: TxSql,
  approvalRequestId: string | null,
  reservationId: string,
) {
  if (!approvalRequestId) return;
  const rows = await tx`
    UPDATE wallet_payment_approval_requests SET
      status = 'consumed', consumed_at = NOW(), reservation_id = ${reservationId}, updated_at = NOW()
    WHERE id = ${approvalRequestId} AND status = 'approved' AND expires_at > NOW()
    RETURNING id
  `;
  if (!rows[0]) throw new WalletSpendPolicyError(409, 'PAYMENT_APPROVAL_INVALID', 'Payment approval could not be consumed');
}
