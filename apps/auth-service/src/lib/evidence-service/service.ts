/**
 * Evidence records and package export (PRD G-5; spec/evidence-package.md,
 * "Producing evidence through the auth service").
 *
 * Every query is scoped to the developer. Evidence records are appended to the
 * developer's audit hash chain with the same lock and hash as POST
 * /v1/audit/log. Export re-verifies every source audit entry's hash, assembles
 * and verifies the package, anchors its root in the audit chain and verifies
 * the final bytes before returning them. Every failure has a reason code.
 */
import { KeyObject, type webcrypto } from 'node:crypto';
import type postgres from 'postgres';
import { computeAuditHash, matchStoredAuditHash } from '../hash.js';
import { newAuditEntryId } from '../ids.js';
import { isPlanName, PLAN_LIMITS } from '../plans.js';
import { anchorAuditEntry, attachAnchor, attachSignature, buildPackage, serializePackage } from '../evidence/build.js';
import { IDENTIFIER_CLASSES } from '../evidence/hashing.js';
import { EvidenceBuildError, VerificationFailure } from '../evidence/result.js';
import { EVIDENCE_SCHEMA_1_0 } from '../evidence/schema-1.0.js';
import { validate } from '../evidence/schema.js';
import { signRoot } from '../evidence/signature.js';
import { verifyPackage } from '../evidence/verify.js';
import { evidenceExportDuration, evidenceRecordsTotal, reportChainVerificationFailure } from './metrics.js';
import { tenantPseudonymisationKey, type EvidenceSettings } from './settings.js';

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const RECORD_TYPES = [
  'run_context', 'tool_call', 'policy_evaluation', 'recommendation', 'decision', 'decision_consumption', 'revocation',
] as const;
export const MAX_RECORDS_PER_REQUEST = 100;
export const MAX_CASE_ENTRIES = 50_000;
const MAX_GRANT_DEPTH = 32;
const CASE_ID = /^[!-~]{1,256}$/;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const CHAIN_CODES = new Set([
  'genesis_mismatch', 'sequence_mismatch', 'link_mismatch', 'entry_hash_mismatch', 'head_mismatch', 'length_mismatch', 'root_mismatch',
]);

export class EvidenceServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldPath: string | null = null,
  ) {
    super(message);
    this.name = 'EvidenceServiceError';
  }
}

export function isValidCaseId(caseId: string): boolean {
  return CASE_ID.test(caseId);
}

// ── Records ──────────────────────────────────────────────────────────────

const ENTRY_SCHEMA: Json = {
  $defs: (EVIDENCE_SCHEMA_1_0 as Json)['$defs'],
  ...((EVIDENCE_SCHEMA_1_0 as Json)['$defs']['entry'] as Json),
};

const RECORD_MEMBERS = new Set(['type', 'at', 'data', 'ext', 'agent_id', 'agent_did']);

function invalid(message: string, fieldPath: string): EvidenceServiceError {
  return new EvidenceServiceError(400, 'EVIDENCE_RECORD_INVALID', message, fieldPath);
}

/** Checks one record on its own: structure plus the rules that need no other entry. */
export function validateRecord(record: unknown, index: number): void {
  const base = `records[${index}]`;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw invalid('record must be an object', base);
  const r = record as Json;
  for (const name of Object.keys(r).sort()) {
    if (!RECORD_MEMBERS.has(name)) throw invalid('unknown member', `${base}.${name}`);
  }
  if (!(RECORD_TYPES as readonly string[]).includes(r['type'])) {
    throw invalid(`type must be one of ${RECORD_TYPES.join(', ')}`, `${base}.type`);
  }
  for (const name of ['agent_id', 'agent_did']) {
    if (name in r && (typeof r[name] !== 'string' || !/^[!-~]{1,256}$/.test(r[name]))) throw invalid('must be a token', `${base}.${name}`);
  }
  const entry: Json = { at: r['at'], data: r['data'], hash: ZERO_DIGEST, prev: ZERO_DIGEST, seq: 0, type: r['type'] };
  if ('ext' in r) entry['ext'] = r['ext'];
  try {
    validate(entry, ENTRY_SCHEMA);
  } catch (err) {
    if (err instanceof VerificationFailure) {
      throw invalid(err.message, err.fieldPath && err.fieldPath !== '$' ? `${base}.${err.fieldPath}` : base);
    }
    throw err;
  }
  const data = r['data'] as Json;
  const path = (p: string): string => `${base}.data.${p}`;
  if (r['type'] === 'tool_call') {
    if (data['outcome'] === 'allowed') {
      if ('denial' in data) throw invalid('an allowed call has no denial', path('denial'));
      if (data['output_hash'] === null) throw invalid('an allowed call has an output hash', path('output_hash'));
    } else {
      if (data['outcome'] === 'denied' && !('denial' in data)) throw invalid('a denied call names its denial reason', path('denial'));
      if (data['outcome'] === 'error' && 'denial' in data) throw invalid('a failed call has no denial', path('denial'));
      if (data['output_hash'] !== null) throw invalid('a call that did not run has no output', path('output_hash'));
      if ((data['upstream_records'] as unknown[]).length > 0) throw invalid('a call that did not run has no upstream records', path('upstream_records'));
    }
    if ('completed_at' in data && data['completed_at'] < data['started_at']) throw invalid('completed before it started', path('completed_at'));
  } else if (r['type'] === 'decision') {
    if (data['approval_position'] > data['approvals_required']) throw invalid('more approvals than required', path('approval_position'));
    if ((data['approval_position'] === 1) === ('first_jti' in data)) throw invalid('first_jti is required exactly for the second approval', path('first_jti'));
    if (data['expires_at'] < data['issued_at']) throw invalid('expires before it was issued', path('expires_at'));
  } else if (r['type'] === 'recommendation') {
    (data['sections'] as Json[]).forEach((section, i) => {
      if (section['status'] !== 'not_available' && (section['evidence'] as unknown[]).length === 0) {
        throw invalid('a section that is not not_available must cite evidence', path(`sections[${i}].evidence`));
      }
    });
  }
}

export interface AppendedRecord {
  audit_entry_id: string;
  hash: string;
}

/** Validate every record, then append them all in one transaction (all or nothing). */
export async function appendEvidenceRecords(sql: Sql, developerId: string, caseId: string, records: unknown): Promise<AppendedRecord[]> {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS_PER_REQUEST) {
    evidenceRecordsTotal.inc({ outcome: 'rejected' });
    throw invalid(`records must be an array of 1 to ${MAX_RECORDS_PER_REQUEST} records`, 'records');
  }
  try {
    records.forEach((record, index) => validateRecord(record, index));
  } catch (err) {
    evidenceRecordsTotal.inc({ outcome: 'rejected' }, records.length);
    throw err;
  }

  const plans = await sql<{ plan: string }[]>`SELECT plan FROM subscriptions WHERE developer_id = ${developerId}`;
  const planName = plans[0]?.plan ?? 'free';
  const limit = PLAN_LIMITS[isPlanName(planName) ? planName : 'free'].auditEntries;

  const appended: AppendedRecord[] = [];
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 0))`;
    const counts = await tx<{ count: string }[]>`SELECT COUNT(*) AS count FROM audit_entries WHERE developer_id = ${developerId}`;
    if (parseInt(counts[0]?.count ?? '0', 10) + records.length > limit) {
      throw new EvidenceServiceError(402, 'PLAN_LIMIT_EXCEEDED', `Plan limit reached: the plan allows ${limit} audit entries`);
    }
    const last = await tx<{ hash: string; timestamp: Date | string }[]>`
      SELECT hash, timestamp FROM audit_entries WHERE developer_id = ${developerId}
      ORDER BY timestamp DESC, id DESC LIMIT 1`;
    let prevHash: string | null = last[0]?.hash ?? null;
    let previousTimestamp = last[0] ? new Date(last[0].timestamp).getTime() : 0;
    for (const record of records as Json[]) {
      const id = newAuditEntryId();
      // Strictly increasing timestamps keep the chain order equal to insertion order.
      previousTimestamp = Math.max(Date.now(), previousTimestamp + 1);
      const timestamp = new Date(previousTimestamp).toISOString();
      const grantId = typeof record['data']['grant_id'] === 'string' ? record['data']['grant_id'] as string : '';
      const metadata: Json = {
        case_id: caseId,
        evidence: { at: record['at'], data: record['data'], type: record['type'], ...('ext' in record ? { ext: record['ext'] } : {}) },
      };
      const fields = {
        id,
        agentId: (record['agent_id'] as string | undefined) ?? '',
        agentDid: (record['agent_did'] as string | undefined) ?? '',
        grantId,
        principalId: 'platform',
        developerId,
        action: `evidence.${record['type'] as string}`,
        metadata,
        timestamp,
        prevHash,
        status: 'success',
      };
      const hash = computeAuditHash(fields);
      await tx`
        INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
        VALUES (${id}, ${fields.agentId}, ${fields.agentDid}, ${grantId}, ${fields.principalId}, ${developerId},
                ${fields.action}, ${tx.json(metadata as postgres.JSONValue)}, ${hash}, ${prevHash}, ${timestamp}, 'success')`;
      appended.push({ audit_entry_id: id, hash });
      prevHash = hash;
    }
  });
  evidenceRecordsTotal.inc({ outcome: 'accepted' }, appended.length);
  return appended;
}

// ── Assembly ─────────────────────────────────────────────────────────────

export interface AuditRow {
  id: string;
  agent_id: string;
  agent_did: string;
  grant_id: string;
  principal_id: string;
  developer_id: string;
  action: string;
  metadata: unknown;
  hash: string;
  previous_hash: string | null;
  timestamp: Date | string;
  status: string | null;
}

export interface GrantRow {
  id: string;
  agent_id: string;
  principal_id: string;
  scopes: string[];
  status: string;
  issued_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  parent_grant_id: string | null;
  purpose: string | null;
  authorization_details: unknown;
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

interface SourcedRecord {
  record: Json;
  order: number;
}

function sourceError(message: string, fieldPath: string | null = null): EvidenceServiceError {
  return new EvidenceServiceError(422, 'EVIDENCE_SOURCE_INVALID', message, fieldPath);
}

/** Map the case's audit entries to package records, verifying each entry's own hash first. */
export function recordsFromAudit(rows: readonly AuditRow[], developerId: string, caseId: string, issuer: string): SourcedRecord[] {
  const out: SourcedRecord[] = [];
  rows.forEach((row, order) => {
    const matched = matchStoredAuditHash({
      id: row.id,
      agentId: row.agent_id,
      agentDid: row.agent_did,
      grantId: row.grant_id,
      principalId: row.principal_id,
      developerId: row.developer_id,
      action: row.action,
      metadata: row.metadata,
      timestamp: iso(row.timestamp),
      prevHash: row.previous_hash,
      status: row.status ?? 'success',
    }, row.hash);
    if (matched === null || row.developer_id !== developerId) {
      reportChainVerificationFailure({ source: 'source_audit', code: 'audit_content', developerId, caseId, auditEntryId: row.id });
      throw new EvidenceServiceError(409, 'EVIDENCE_CHAIN_VERIFICATION_FAILED', `audit entry ${row.id} does not match its hash`);
    }
    const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Json;
    const source = { audit_entry_id: row.id, audit_hash: row.hash };
    if (row.action.startsWith('evidence.')) {
      const evidence = metadata['evidence'] as Json | undefined;
      if (metadata['case_id'] !== caseId || !evidence) return;
      if (!(RECORD_TYPES as readonly string[]).includes(evidence['type']) || row.action !== `evidence.${String(evidence['type'])}`) {
        throw sourceError(`audit entry ${row.id} is not a valid evidence record`);
      }
      const record: Json = { at: evidence['at'], data: evidence['data'], source, type: evidence['type'] };
      if ('ext' in evidence) record['ext'] = evidence['ext'];
      out.push({ record, order });
    } else if (row.action === 'decision.approved') {
      const action = metadata['action'] as Json | undefined;
      if (!action || action['case_id'] !== caseId) return;
      const approver = metadata['approver'] as Json | undefined;
      const data: Json = {
        action,
        action_hash: metadata['action_hash'],
        approval_position: metadata['approval_position'],
        approvals_required: metadata['approvals_required'],
        approver: approver?.['sub'],
        approver_auth: metadata['approver_auth'],
        dwell_ms: metadata['dwell_ms'],
        expires_at: metadata['expires_at'],
        issued_at: iso(row.timestamp),
        issuer,
        jti: metadata['jti'],
      };
      if (typeof metadata['first_jti'] === 'string') data['first_jti'] = metadata['first_jti'];
      if (typeof metadata['request_id'] === 'string') data['request_id'] = metadata['request_id'];
      out.push({ record: { at: iso(row.timestamp), data, source, type: 'decision' }, order });
    } else if (row.action === 'decision.consumed') {
      const action = metadata['action'] as Json | undefined;
      if (!action || action['case_id'] !== caseId) return;
      out.push({
        record: {
          at: iso(row.timestamp),
          data: { action_hash: metadata['action_hash'], consumed_at: iso(row.timestamp), jtis: metadata['jtis'] },
          source,
          type: 'decision_consumption',
        },
        order,
      });
    }
  });
  return out;
}

function grantStatus(row: GrantRow, now: Date): string {
  if (row.status === 'revoked' || row.revoked_at !== null) return 'revoked';
  if (row.status === 'expired' || new Date(row.expires_at).getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** Select the grant chain (root first) that contains every grant the case's tool calls used. */
export function selectGrantChain(chains: ReadonlyArray<readonly GrantRow[]>): GrantRow[] {
  const sorted = [...chains].sort((a, b) => b.length - a.length);
  const longest = sorted[0];
  if (!longest) throw new EvidenceServiceError(422, 'EVIDENCE_INCOMPLETE', 'no tool call in this case names a grant');
  const ids = longest.map((g) => g.id);
  for (const chain of sorted) {
    if (!chain.every((grant, index) => ids[index] === grant.id)) {
      throw new EvidenceServiceError(422, 'EVIDENCE_GRANT_CHAIN_AMBIGUOUS', 'tool calls used grants that are not on one delegation chain');
    }
  }
  return [...longest];
}

export interface AssembleInput {
  developerId: string;
  caseId: string;
  issuer: string;
  exportedAt: Date;
  state?: 'open' | 'decided' | 'closed';
  records: SourcedRecord[];
  chain: readonly GrantRow[];
}

export function assembleRecords(input: AssembleInput): { caseMember: Json; entries: Json[] } {
  const grants: Json[] = input.chain.map((row, depth) => ({
    at: iso(row.issued_at),
    data: {
      agent_id: row.agent_id,
      authorization_details: Array.isArray(row.authorization_details) ? row.authorization_details : [],
      depth,
      expires_at: iso(row.expires_at),
      grant_id: row.id,
      issued_at: iso(row.issued_at),
      parent_grant_id: depth === 0 ? null : input.chain[depth - 1]!.id,
      principal: row.principal_id,
      purpose: row.purpose,
      scopes: row.scopes,
      status: grantStatus(row, input.exportedAt),
    },
    type: 'grant',
  }));
  const recorded = new Set(
    input.records.filter((r) => r.record['type'] === 'revocation').map((r) => r.record['data']?.['grant_id']),
  );
  const synthesised: SourcedRecord[] = input.chain
    .filter((row) => row.revoked_at !== null && !recorded.has(row.id))
    .map((row, i) => ({
      record: { at: iso(row.revoked_at!), data: { grant_id: row.id, revoked_at: iso(row.revoked_at!) }, type: 'revocation' },
      order: Number.MAX_SAFE_INTEGER - input.chain.length + i,
    }));
  const rest = [...input.records, ...synthesised].sort((a, b) => {
    const at = String(a.record['at']);
    const bt = String(b.record['at']);
    return at < bt ? -1 : at > bt ? 1 : a.order - b.order;
  });
  const decided = rest.some((r) => r.record['type'] === 'decision_consumption');
  return {
    caseMember: {
      case_id: input.caseId,
      exported_at: input.exportedAt.toISOString(),
      issuer: input.issuer,
      state: input.state ?? (decided ? 'decided' : 'open'),
      tenant_id: input.developerId,
    },
    entries: [...grants, ...rest.map((r) => r.record)],
  };
}

// ── Export ───────────────────────────────────────────────────────────────

export interface ExportOptions {
  disclose?: unknown;
  sign?: unknown;
  state?: unknown;
}

export interface ExportSigner {
  privateKey: unknown;
  kid: string;
}

export interface ExportResult {
  data: Uint8Array;
  root: string;
  anchorHash: string;
  entryCount: number;
}

function parseOptions(options: ExportOptions): { disclose: string[]; sign: boolean; state?: 'open' | 'decided' | 'closed' } {
  const disclose = options.disclose ?? [];
  if (!Array.isArray(disclose) || disclose.some((c) => !(IDENTIFIER_CLASSES as readonly string[]).includes(c as string))) {
    throw new EvidenceServiceError(400, 'BAD_REQUEST', `disclose must be a list of ${IDENTIFIER_CLASSES.join(', ')}`, 'disclose');
  }
  if (options.sign !== undefined && typeof options.sign !== 'boolean') {
    throw new EvidenceServiceError(400, 'BAD_REQUEST', 'sign must be a boolean', 'sign');
  }
  if (options.state !== undefined && !['open', 'decided', 'closed'].includes(options.state as string)) {
    throw new EvidenceServiceError(400, 'BAD_REQUEST', 'state must be open, decided or closed', 'state');
  }
  return {
    disclose: [...new Set(disclose as string[])].sort(),
    sign: options.sign === true,
    ...(options.state !== undefined ? { state: options.state as 'open' | 'decided' | 'closed' } : {}),
  };
}

async function loadCaseAuditRows(sql: Sql, developerId: string, caseId: string): Promise<AuditRow[]> {
  const [evidenceRows, decisionRows] = await Promise.all([
    sql<AuditRow[]>`
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
      FROM audit_entries
      WHERE developer_id = ${developerId} AND action LIKE 'evidence.%' AND action <> 'evidence.package_exported'
        AND metadata->>'case_id' = ${caseId}
      ORDER BY timestamp ASC, id ASC
      LIMIT ${MAX_CASE_ENTRIES + 1}`,
    sql<AuditRow[]>`
      SELECT id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status
      FROM audit_entries
      WHERE developer_id = ${developerId} AND action IN ('decision.approved', 'decision.consumed')
        AND (metadata->'action')->>'case_id' = ${caseId}
      ORDER BY timestamp ASC, id ASC
      LIMIT ${MAX_CASE_ENTRIES + 1}`,
  ]);
  const rows = [...evidenceRows, ...decisionRows].sort((a, b) => {
    const at = iso(a.timestamp);
    const bt = iso(b.timestamp);
    return at < bt ? -1 : at > bt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  if (rows.length > MAX_CASE_ENTRIES) {
    throw new EvidenceServiceError(413, 'EVIDENCE_CASE_TOO_LARGE', `a case may have at most ${MAX_CASE_ENTRIES} evidence entries`);
  }
  return rows;
}

async function loadGrantChain(sql: Sql, developerId: string, grantId: string): Promise<GrantRow[]> {
  const rows = await sql<Array<GrantRow & { hops: number }>>`
    WITH RECURSIVE chain AS (
      SELECT g.id, g.agent_id, g.principal_id, g.scopes, g.status, g.issued_at, g.expires_at, g.revoked_at,
             g.parent_grant_id, g.purpose, g.authorization_details, 0 AS hops
      FROM grants g WHERE g.id = ${grantId} AND g.developer_id = ${developerId}
      UNION ALL
      SELECT p.id, p.agent_id, p.principal_id, p.scopes, p.status, p.issued_at, p.expires_at, p.revoked_at,
             p.parent_grant_id, p.purpose, p.authorization_details, c.hops + 1
      FROM grants p JOIN chain c ON p.id = c.parent_grant_id
      WHERE p.developer_id = ${developerId} AND c.hops < ${MAX_GRANT_DEPTH}
    )
    SELECT * FROM chain ORDER BY hops DESC`;
  if (rows.length === 0) {
    throw sourceError(`grant ${grantId} used by a tool call does not exist for this developer`);
  }
  if (rows[0]!.parent_grant_id !== null) {
    throw sourceError(`grant chain of ${grantId} is deeper than ${MAX_GRANT_DEPTH} or leaves this developer`);
  }
  return rows.map(({ hops: _hops, ...grant }) => grant);
}

/** Assemble, anchor and return the evidence package of a case. */
export async function exportCasePackage(
  sql: Sql,
  input: {
    developerId: string;
    caseId: string;
    issuer: string;
    settings: EvidenceSettings;
    options: ExportOptions;
    signer?: () => ExportSigner;
    now?: () => Date;
  },
): Promise<ExportResult> {
  const started = process.hrtime.bigint();
  const observe = (outcome: string): void => {
    evidenceExportDuration.observe({ outcome }, Number(process.hrtime.bigint() - started) / 1e9);
  };
  try {
    const result = await exportInner(sql, input);
    observe('success');
    return result;
  } catch (err) {
    observe('error');
    throw err;
  }
}

async function exportInner(
  sql: Sql,
  input: Parameters<typeof exportCasePackage>[1],
): Promise<ExportResult> {
  const { developerId, caseId, issuer, settings } = input;
  const options = parseOptions(input.options);
  const now = input.now ?? (() => new Date());
  const everything = options.disclose.join(',') === IDENTIFIER_CLASSES.join(',');
  if (!everything && settings.secret === null) {
    throw new EvidenceServiceError(503, 'EVIDENCE_PSEUDONYMISATION_KEY_MISSING', 'pseudonymisation is not configured; disclose every identifier class or configure a key');
  }

  const rows = await loadCaseAuditRows(sql, developerId, caseId);
  if (rows.length === 0) throw new EvidenceServiceError(404, 'EVIDENCE_CASE_NOT_FOUND', 'no evidence recorded for this case');
  const records = recordsFromAudit(rows, developerId, caseId, issuer);

  const grantIds = [...new Set(records
    .filter((r) => r.record['type'] === 'tool_call' && typeof r.record['data']?.['grant_id'] === 'string')
    .map((r) => r.record['data']['grant_id'] as string))];
  const chains = await Promise.all(grantIds.map((id) => loadGrantChain(sql, developerId, id)));
  const chain = selectGrantChain(chains);

  const { caseMember, entries } = assembleRecords({
    developerId, caseId, issuer, exportedAt: now(), records, chain, ...(options.state ? { state: options.state } : {}),
  });

  let built;
  try {
    built = buildPackage({
      case: caseMember,
      entries,
      privacy: everything
        ? { disclosed: options.disclose }
        : { disclosed: options.disclose, key: tenantPseudonymisationKey(settings.secret!, developerId), keyId: settings.keyId },
    });
  } catch (err) {
    if (err instanceof EvidenceBuildError) {
      if (CHAIN_CODES.has(err.code)) {
        reportChainVerificationFailure({ source: 'package', code: err.code, developerId, caseId, fieldPath: err.fieldPath });
        throw new EvidenceServiceError(409, 'EVIDENCE_CHAIN_VERIFICATION_FAILED', err.message, err.fieldPath);
      }
      throw new EvidenceServiceError(422, 'EVIDENCE_SOURCE_INVALID', err.message, err.fieldPath);
    }
    throw err;
  }

  // Anchor the root in the developer's audit chain.
  let anchor: Json | undefined;
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 0))`;
    const last = await tx<{ hash: string; timestamp: Date | string }[]>`
      SELECT hash, timestamp FROM audit_entries WHERE developer_id = ${developerId}
      ORDER BY timestamp DESC, id DESC LIMIT 1`;
    const lastTime = last[0] ? new Date(last[0].timestamp).getTime() : 0;
    const timestamp = new Date(Math.max(now().getTime(), lastTime + 1)).toISOString();
    anchor = anchorAuditEntry(built.document, { auditEntryId: newAuditEntryId(), timestamp, prevHash: last[0]?.hash ?? null });
    const stored = computeAuditHash({
      id: anchor['id'], agentId: '', agentDid: '', grantId: '', principalId: 'platform', developerId,
      action: 'evidence.package_exported', metadata: anchor['metadata'], timestamp, prevHash: anchor['prevHash'], status: 'success',
    });
    if (stored !== anchor['hash']) {
      reportChainVerificationFailure({ source: 'package', code: 'anchor_hash_mismatch', developerId, caseId });
      throw new EvidenceServiceError(409, 'EVIDENCE_CHAIN_VERIFICATION_FAILED', 'anchor hash does not match the audit chain layout');
    }
    await tx`
      INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
      VALUES (${anchor['id']}, '', '', '', 'platform', ${developerId}, 'evidence.package_exported',
              ${tx.json(anchor['metadata'] as postgres.JSONValue)}, ${anchor['hash']}, ${anchor['prevHash']}, ${timestamp}, 'success')`;
  });

  let document = attachAnchor(built.document, anchor!);
  if (options.sign) {
    if (!input.signer) throw new EvidenceServiceError(503, 'EVIDENCE_SIGNING_UNAVAILABLE', 'no signing key is available');
    const signer = input.signer();
    const key = signer.privateKey instanceof KeyObject ? signer.privateKey : KeyObject.from(signer.privateKey as webcrypto.CryptoKey);
    document = attachSignature(document, signRoot(built.root, key, signer.kid));
  }
  const data = serializePackage(document);
  const check = verifyPackage(data, {
    expectedRoot: built.root,
    expectedAnchorHash: anchor!['hash'],
    requireAnchor: true,
    allowUnverifiedSignature: true,
  });
  if (!check.ok) {
    reportChainVerificationFailure({ source: 'package', code: check.code ?? 'unknown', developerId, caseId, fieldPath: check.fieldPath });
    throw new EvidenceServiceError(409, 'EVIDENCE_CHAIN_VERIFICATION_FAILED', check.message, check.fieldPath);
  }
  return { data, root: built.root, anchorHash: anchor!['hash'] as string, entryCount: built.document['chain']['length'] as number };
}
