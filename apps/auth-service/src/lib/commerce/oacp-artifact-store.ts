// SPDX-License-Identifier: Apache-2.0
/**
 * Persistence, replay and revocation of OACP artifacts (migration 133,
 * `oacp_artifacts`).
 *
 * - Every issuance writes one row per artifact in the same transaction as its
 *   status-list entry; a failure rolls both back.
 * - Every refused issuance writes one `refused` row: the refusal code and a
 *   public-safe record, never a signature.
 * - Revocation sets the artifact's status-list entry to INVALID (final),
 *   marks the row `revoked`, and issues a signed `revocation` artifact naming
 *   it, itself on the status list, all in one transaction.
 */
import type postgres from 'postgres';
import { queries, type TxSql } from '../../db/client.js';
import { config } from '../../config.js';
import { newOacpArtifactId, newOacpRefusalId } from './ids.js';
import { getActiveOacpSigner } from './oacp-issuer-keys.js';
import { issueOacpArtifact, verifyOacpArtifact } from './oacp-jws.js';
import {
  assertOacpStatusBaseUsable,
  allocateOacpStatusEntry,
  oacpStatusListIdFromUri,
  readOacpStatus,
  setOacpStatus,
} from './oacp-status.js';
import {
  issueC6ZInternalOacpArtifacts,
  type C6ZConnectorEvidence,
  type C6ZIssuanceResult,
  type C6ZPublicDiscoveryEligibility,
  type C6ZSellerAuthorityRequest,
} from './oacp-runtime-vertical.js';
import { OACP_ARTIFACT_TTLS_SECONDS, type OacpArtifactEnvelope, type OacpArtifactSafety } from './oacp-trust-artifacts.js';

type Sql = ReturnType<typeof postgres>;

export type OacpArtifactRowStatus = 'issued' | 'refused' | 'revoked';

export interface OacpArtifactRecord {
  artifact_id: string;
  family: string;
  artifact_type: string | null;
  tenant_id: string | null;
  merchant_id: string | null;
  seller_agent_id: string | null;
  issuer_key_id: string | null;
  payload_hash: string | null;
  envelope: OacpArtifactEnvelope | null;
  payload: Record<string, unknown>;
  status: OacpArtifactRowStatus;
  status_list: { uri: string; idx: number } | null;
  request_id: string | null;
  issued_at: string | null;
  expires_at: string | null;
  refusal_code: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  revocation_artifact_id: string | null;
  suspended_at: string | null;
  suspension_reason: string | null;
  created_at: string;
}

export class OacpArtifactStoreError extends Error {
  readonly code: 'artifact_not_found' | 'artifact_not_revocable' | 'artifact_not_suspendable';

  constructor(code: OacpArtifactStoreError['code'], message: string) {
    super(message);
    this.name = 'OacpArtifactStoreError';
    this.code = code;
  }
}

/** Thrown inside the issuing transaction to roll it back on a late refusal. */
class IssuanceRolledBack extends Error {
  constructor(readonly result: C6ZIssuanceResult) {
    super('issuance refused');
  }
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function rowToRecord(row: Record<string, unknown>): OacpArtifactRecord {
  const uri = asText(row['status_list_uri']);
  const idx = row['status_idx'];
  return {
    artifact_id: row['artifact_id'] as string,
    family: row['family'] as string,
    artifact_type: asText(row['artifact_type']),
    tenant_id: asText(row['tenant_id']),
    merchant_id: asText(row['merchant_id']),
    seller_agent_id: asText(row['seller_agent_id']),
    issuer_key_id: asText(row['issuer_key_id']),
    payload_hash: asText(row['payload_hash']),
    envelope: (row['envelope'] as OacpArtifactEnvelope | null) ?? null,
    payload: row['payload'] as Record<string, unknown>,
    status: row['status'] as OacpArtifactRowStatus,
    status_list: uri !== null && idx !== null && idx !== undefined ? { uri, idx: Number(idx) } : null,
    request_id: asText(row['request_id']),
    issued_at: iso(row['issued_at']),
    expires_at: iso(row['expires_at']),
    refusal_code: asText(row['refusal_code']),
    revoked_at: iso(row['revoked_at']),
    revocation_reason: asText(row['revocation_reason']),
    revocation_artifact_id: asText(row['revocation_artifact_id']),
    suspended_at: iso(row['suspended_at']),
    suspension_reason: asText(row['suspension_reason']),
    created_at: iso(row['created_at']) ?? '',
  };
}

const COLUMNS = `artifact_id, family, artifact_type, tenant_id, merchant_id, seller_agent_id,
  issuer_key_id, payload_hash, envelope, payload, status, status_list_uri, status_idx,
  request_id, issued_at, expires_at, refusal_code, revoked_at, revocation_reason,
  revocation_artifact_id, suspended_at, suspension_reason, created_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact`;

async function insertIssued(
  tx: TxSql,
  row: { family: string; envelope: OacpArtifactEnvelope; payload: Record<string, unknown>; request_id: string | null },
): Promise<void> {
  const { envelope } = row;
  const statusList = envelope.status?.status_list;
  await tx`
    INSERT INTO oacp_artifacts (
      artifact_id, family, artifact_type, tenant_id, merchant_id, seller_agent_id,
      issuer_key_id, payload_hash, jws, envelope, payload, status_list_uri, status_idx,
      request_id, issued_at, expires_at, status
    ) VALUES (
      ${envelope.artifact_id}, ${row.family}, ${envelope.artifact_type}, ${envelope.tenant_id ?? null},
      ${envelope.merchant_id ?? null}, ${envelope.seller_agent_id ?? null}, ${envelope.issuer_key_id},
      ${envelope.payload_hash}, ${envelope.signature}, ${tx.json(envelope as never)}, ${tx.json(row.payload as never)},
      ${statusList?.uri ?? null}, ${statusList?.idx ?? null}, ${row.request_id},
      ${envelope.issued_at}, ${envelope.expires_at}, 'issued'
    )
  `;
}

/** Record a refused issuance: the code and a public-safe summary, no signature. */
export async function recordOacpRefusal(
  sql: TxSql,
  input: {
    request?: Partial<C6ZSellerAuthorityRequest> | null | undefined;
    result: C6ZIssuanceResult;
  },
): Promise<string> {
  const id = newOacpRefusalId();
  const request = input.request ?? null;
  const record = {
    authority_request_ref: input.result.authority_request_ref,
    request_status: input.result.status,
    refusal_code: input.result.refusal_code ?? 'refused',
    message: input.result.message,
    allowed_to_execute: false,
  };
  await sql`
    INSERT INTO oacp_artifacts (
      artifact_id, family, tenant_id, merchant_id, seller_agent_id, payload, request_id,
      status, refusal_code
    ) VALUES (
      ${id}, 'authority_request_status', ${asText(request?.tenant_id)}, ${asText(request?.merchant_id)},
      ${asText(request?.seller_agent_id)}, ${sql.json(record as never)}, ${asText(request?.request_id)},
      'refused', ${record.refusal_code}
    )
  `;
  return id;
}

/**
 * Whether issuance may enable public discovery for a tenant:
 * OACP_PUBLIC_DISCOVERY_ISSUANCE_ENABLED (default off) and the tenant on the
 * authority service allowlist (COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS),
 * whoever calls.
 */
export function c6zPublicDiscoveryEligibility(tenantId: string): C6ZPublicDiscoveryEligibility {
  return {
    issuance_enabled: config.oacpPublicDiscoveryIssuanceEnabled,
    tenant_allowlisted: (process.env['COMMERCE_C6Z_AUTHORITY_SERVICE_TENANTS'] ?? '')
      .split(',').map((item) => item.trim()).filter(Boolean)
      .includes(tenantId),
  };
}

/**
 * Issue the C6Z artifact set and persist it, or persist the refusal. The
 * issuer clock decides `issued_at`; signing happens inside the transaction
 * that allocates the status-list entries and writes the rows.
 */
export async function issueAndPersistC6ZArtifacts(
  sql: Sql,
  input: { request: C6ZSellerAuthorityRequest; evidence: C6ZConnectorEvidence; mandate_capability_evidence?: unknown; now_iso: string },
): Promise<C6ZIssuanceResult & { refusal_record_id?: string }> {
  assertOacpStatusBaseUsable();
  const signer = await getActiveOacpSigner(sql);
  try {
    return await sql.begin(async (handle) => {
      const tx = handle as unknown as TxSql;
      const result = await issueC6ZInternalOacpArtifacts({
        ...input,
        context: {
          issuer: config.jwtIssuer,
          signer,
          newArtifactId: newOacpArtifactId,
          allocateStatus: (artifactId) => allocateOacpStatusEntry(tx, artifactId),
          publicDiscovery: c6zPublicDiscoveryEligibility(input.request.tenant_id),
        },
      });
      if (result.status !== 'artifact_issuance_ready') throw new IssuanceRolledBack(result);
      for (const artifact of result.artifacts) {
        await insertIssued(tx, {
          family: artifact.artifact_family,
          envelope: artifact.envelope,
          payload: artifact.payload,
          request_id: input.request.request_id ?? null,
        });
      }
      return result;
    }) as C6ZIssuanceResult;
  } catch (err) {
    if (!(err instanceof IssuanceRolledBack)) throw err;
    const refusal_record_id = await recordOacpRefusal(queries(sql), { request: input.request, result: err.result });
    return { ...err.result, refusal_record_id };
  }
}

export async function getOacpArtifact(sql: Sql | TxSql, artifactId: string): Promise<OacpArtifactRecord | null> {
  const rows = await sql.unsafe(`SELECT ${COLUMNS} FROM oacp_artifacts WHERE artifact_id = $1`, [artifactId]);
  return rows[0] ? rowToRecord(rows[0] as Record<string, unknown>) : null;
}

export interface OacpReplayQuery {
  tenant_id: string;
  merchant_id?: string | null | undefined;
  seller_agent_id?: string | null | undefined;
  /** Rows created at or after this instant (inclusive). */
  since?: string | null | undefined;
  /** With `since`: skip rows at exactly `since` up to and including this id. */
  after_artifact_id?: string | null | undefined;
  limit: number;
}

/**
 * Replay a tenant's artifacts in creation order. Page with the returned
 * `next` (`since` and `after_artifact_id` of the last row).
 */
export async function listOacpArtifacts(
  sql: Sql,
  query: OacpReplayQuery,
): Promise<{ artifacts: OacpArtifactRecord[]; next: { since: string; after_artifact_id: string } | null }> {
  const limit = Math.min(Math.max(query.limit, 1), 500);
  const rows = await sql.unsafe(
    `SELECT ${COLUMNS} FROM oacp_artifacts
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR merchant_id = $2)
        AND ($3::text IS NULL OR seller_agent_id = $3)
        AND ($4::text IS NULL OR (created_at, artifact_id) > ($4::text::timestamptz, COALESCE($5::text, '')))
      ORDER BY created_at, artifact_id
      LIMIT $6`,
    [query.tenant_id, query.merchant_id ?? null, query.seller_agent_id ?? null, query.since ?? null,
      query.after_artifact_id ?? null, limit + 1],
  );
  const records = (rows as unknown as Array<Record<string, unknown>>).map(rowToRecord);
  let next: { since: string; after_artifact_id: string } | null = null;
  if (records.length > limit) {
    records.length = limit;
    const last = records[limit - 1]!;
    // The microsecond timestamp, passed as text: postgres.js serialises a
    // timestamptz parameter through Date, which keeps milliseconds only and
    // would replay the rows of the same millisecond.
    const exact = (rows as unknown as Array<Record<string, unknown>>)[limit - 1]!['created_at_exact'] as string;
    next = { since: exact, after_artifact_id: last.artifact_id };
  }
  return { artifacts: records, next };
}

/** The status-list value recorded for an artifact (0 VALID, 1 INVALID, 2 SUSPENDED), or null. */
export async function readOacpArtifactStatusValue(record: OacpArtifactRecord): Promise<number | null> {
  if (!record.status_list) return null;
  return readOacpStatus(record.status_list.uri, record.status_list.idx);
}

const REVOCATION_SAFETY: OacpArtifactSafety = {
  public_safe: true,
  contains_private_data: false,
  allowed_agent_uses: ['revocation_check'],
  forbidden_agent_uses: ['checkout_payment_execution', 'order_creation', 'public_discovery_publication'],
  commitment_allowed: false,
  offline_commitment_allowed: false,
  requires_online_confirmation: true,
  requires_provider_direct_verification: false,
  requires_merchant_system_confirmation: false,
  stale_behavior: 'refuse_all',
  refusal_code_if_invalid: 'oacp_revocation_invalid',
};

const REASON_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Revoke an issued artifact. Idempotent: revoking a revoked artifact returns
 * the revocation recorded the first time. Refusal records and revocation
 * artifacts cannot be revoked.
 */
export async function revokeOacpArtifact(
  sql: Sql,
  artifactId: string,
  options: { reason_code?: string | undefined; now?: Date | undefined } = {},
): Promise<{ artifact: OacpArtifactRecord; revocation: OacpArtifactRecord; already_revoked: boolean }> {
  const reason = options.reason_code && REASON_RE.test(options.reason_code) ? options.reason_code : 'issuer_revoked';
  assertOacpStatusBaseUsable();
  const signer = await getActiveOacpSigner(sql);
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const rows = await tx.unsafe(`SELECT ${COLUMNS} FROM oacp_artifacts WHERE artifact_id = $1 FOR UPDATE`, [artifactId]);
    if (!rows[0]) throw new OacpArtifactStoreError('artifact_not_found', 'OACP artifact not found');
    const record = rowToRecord(rows[0] as Record<string, unknown>);
    if (record.status === 'refused' || record.family === 'revocation' || !record.status_list || !record.envelope) {
      throw new OacpArtifactStoreError('artifact_not_revocable', 'Only issued OACP artifacts can be revoked');
    }
    if (record.status === 'revoked' && record.revocation_artifact_id) {
      const existing = await getOacpArtifact(tx, record.revocation_artifact_id);
      return { artifact: record, revocation: existing!, already_revoked: true };
    }

    const now = options.now ?? new Date();
    await setOacpStatus(tx, record.status_list.uri, record.status_list.idx, 'invalid');

    const revocationId = newOacpArtifactId();
    const statusList = await allocateOacpStatusEntry(tx, revocationId);
    const nowIso = now.toISOString();
    const expiresMillis = Math.min(
      Math.max(Date.parse(record.expires_at ?? nowIso), now.getTime() + 5 * 60_000),
      now.getTime() + OACP_ARTIFACT_TTLS_SECONDS.revocation * 1000,
    );
    const payload = {
      artifact_family: 'revocation',
      tenant_id: record.tenant_id,
      merchant_id: record.merchant_id,
      seller_agent_id: record.seller_agent_id,
      revocation_list_id: oacpStatusListIdFromUri(record.status_list.uri),
      revoked_artifact_ids: [record.artifact_id],
      revoked_artifact_status_list: { uri: record.status_list.uri, idx: record.status_list.idx },
      revoked_subject_ids: [],
      reason_codes: [reason],
      effective_at: nowIso,
      emergency_disable: false,
      allowed_to_execute: false,
      no_payment_execution: true,
      no_public_discovery_enablement: true,
      non_authoritative_for_transaction: true,
    };
    const envelope = issueOacpArtifact({
      artifact_id: revocationId,
      artifact_type: 'revocation',
      issuer: config.jwtIssuer,
      signer,
      subject_type: 'revocation',
      subject_id: record.artifact_id,
      tenant_id: record.tenant_id ?? undefined,
      merchant_id: record.merchant_id ?? undefined,
      seller_agent_id: record.seller_agent_id ?? undefined,
      buyer_agent_id: '',
      issued_at: nowIso,
      expires_at: new Date(expiresMillis).toISOString(),
      policy_version: record.envelope.policy_version,
      status_list: statusList,
      evidence_refs: [record.artifact_id],
      payload,
      safety: REVOCATION_SAFETY,
    });
    const check = verifyOacpArtifact({ envelope, payload, jwks: { keys: [signer.publicJwk] }, now_iso: nowIso, status: 0 });
    if (!check.valid) throw new Error(`revocation artifact failed self-verification: ${check.refusal_code}`);
    await insertIssued(tx, { family: 'revocation', envelope, payload, request_id: null });
    await tx`
      UPDATE oacp_artifacts
      SET status = 'revoked', revoked_at = ${nowIso}, revocation_reason = ${reason},
          revocation_artifact_id = ${revocationId}
      WHERE artifact_id = ${record.artifact_id}
    `;
    const artifact = (await getOacpArtifact(tx, record.artifact_id))!;
    const revocation = (await getOacpArtifact(tx, revocationId))!;
    return { artifact, revocation, already_revoked: false };
  }) as { artifact: OacpArtifactRecord; revocation: OacpArtifactRecord; already_revoked: boolean };
}

/**
 * The issued, unexpired artifacts of one merchant / seller-agent scope, newest
 * first. Revoked and refused rows are excluded (revocation flips the row and
 * the status-list entry in one transaction).
 */
export async function listLiveOacpArtifactsForScope(
  sql: Sql,
  scope: { tenant_id: string; merchant_id: string; seller_agent_id: string },
  nowIso: string,
): Promise<OacpArtifactRecord[]> {
  const rows = await sql.unsafe(
    `SELECT ${COLUMNS} FROM oacp_artifacts
      WHERE tenant_id = $1 AND merchant_id = $2 AND seller_agent_id = $3
        AND status = 'issued' AND expires_at > $4::text::timestamptz
      ORDER BY created_at DESC, artifact_id DESC
      LIMIT 200`,
    [scope.tenant_id, scope.merchant_id, scope.seller_agent_id, nowIso],
  );
  return (rows as unknown as Array<Record<string, unknown>>).map(rowToRecord);
}

/**
 * Suspend (status 2) or reinstate (status 0) an issued artifact on its Token
 * Status List (draft-ietf-oauth-status-list section 7.1). Reversible, unlike
 * revocation; refused for refusal records, revocation artifacts and revoked
 * artifacts. Idempotent: `changed` is false when the artifact was already in
 * the asked state.
 */
export async function setOacpArtifactSuspension(
  sql: Sql,
  artifactId: string,
  suspend: boolean,
  options: { reason_code?: string | undefined; now?: Date | undefined } = {},
): Promise<{ artifact: OacpArtifactRecord; changed: boolean }> {
  const reason = options.reason_code && REASON_RE.test(options.reason_code) ? options.reason_code : 'issuer_suspended';
  const nowIso = (options.now ?? new Date()).toISOString();
  return await sql.begin(async (handle) => {
    const tx = handle as unknown as TxSql;
    const rows = await tx.unsafe(`SELECT ${COLUMNS} FROM oacp_artifacts WHERE artifact_id = $1 FOR UPDATE`, [artifactId]);
    if (!rows[0]) throw new OacpArtifactStoreError('artifact_not_found', 'OACP artifact not found');
    const record = rowToRecord(rows[0] as Record<string, unknown>);
    if (record.status !== 'issued' || record.family === 'revocation' || !record.status_list) {
      throw new OacpArtifactStoreError('artifact_not_suspendable', 'Only issued, unrevoked OACP artifacts can be suspended or reinstated');
    }
    if ((record.suspended_at !== null) === suspend) return { artifact: record, changed: false };
    await setOacpStatus(tx, record.status_list.uri, record.status_list.idx, suspend ? 'suspended' : 'valid');
    await tx`
      UPDATE oacp_artifacts
         SET suspended_at = ${suspend ? nowIso : null}, suspension_reason = ${suspend ? reason : null}
       WHERE artifact_id = ${artifactId}
    `;
    return { artifact: (await getOacpArtifact(tx, artifactId))!, changed: true };
  }) as { artifact: OacpArtifactRecord; changed: boolean };
}
