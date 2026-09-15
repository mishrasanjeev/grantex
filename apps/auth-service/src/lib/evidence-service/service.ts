/**
 * Evidence records and package export (PRD G-5; spec/evidence-package.md,
 * "Producing evidence through the auth service").
 *
 * - Every query is scoped to the developer, and every write holds the
 *   developer's audit advisory lock (the same lock POST /v1/audit/log takes).
 * - Records are validated completely when they are written - structure,
 *   record-level rules and references to records already on the case - so a
 *   case that accepted its records can always be exported.
 * - Records are idempotent on their own id: the same id with the same content
 *   is a no-op, with different content a conflict. Mistakes are voided, never
 *   deleted.
 * - Export re-verifies each source audit entry's hash and its link to the
 *   entry before it, takes decisions only from the decision-grant store, and
 *   orders entries by server recording time.
 */
import { KeyObject, type webcrypto } from 'node:crypto';
import { CompactSign } from 'jose';
import type postgres from 'postgres';
import { incrementBase32 } from 'ulid';
import { computeAuditHash, matchStoredAuditHash } from '../hash.js';
import { newAuditEntryId } from '../ids.js';
import { logger } from '../logger.js';
import { isPlanName, PLAN_LIMITS } from '../plans.js';
import { anchorAuditEntry, attachAnchor, attachSignature, buildPackage, serializePackage } from '../evidence/build.js';
import { MAX_CLOCK_SKEW_MS } from '../evidence/checks.js';
import { IDENTIFIER_CLASSES, PLATFORM_MARKER, decisionActionHash, digest } from '../evidence/hashing.js';
import { EvidenceBuildError, VerificationFailure } from '../evidence/result.js';
import { EVIDENCE_SCHEMA_1_0 } from '../evidence/schema-1.0.js';
import { timestampMs, validate } from '../evidence/schema.js';
import { protectedHeader, signedPayload } from '../evidence/signature.js';
import { verifyPackage } from '../evidence/verify.js';
import { evidenceExportDuration, evidenceRecordsTotal, reportChainVerificationFailure } from './metrics.js';
import { tenantPseudonymisationKey, type EvidenceSettings } from './settings.js';

type Sql = ReturnType<typeof postgres>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const RECORD_TYPES = ['run_context', 'tool_call', 'policy_evaluation', 'recommendation', 'disposition'] as const;
export const VOIDABLE_TYPES = RECORD_TYPES;
export const ID_FIELDS: Record<string, string> = {
  run_context: 'run_id',
  tool_call: 'call_id',
  policy_evaluation: 'evaluation_id',
  recommendation: 'recommendation_id',
  disposition: 'disposition_id',
};
export const MAX_RECORDS_PER_REQUEST = 100;
export const MAX_CASE_ENTRIES = 50_000;
const MAX_GRANT_DEPTH = 32;
const CASE_ID = /^[!-~]{1,256}$/;
const TOKEN = /^[!-~]{1,256}$/;
const ZERO_DIGEST = `sha256:${'0'.repeat(64)}`;
const PLACEHOLDER_TIME = '2000-01-01T00:00:00.000Z';
const CHAIN_CODES = new Set(['genesis_mismatch', 'sequence_mismatch', 'link_mismatch', 'entry_hash_mismatch', 'head_mismatch', 'length_mismatch', 'root_mismatch']);

export class EvidenceServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fieldPath: string | null = null) {
    super(message);
    this.name = 'EvidenceServiceError';
  }
}

export function isValidCaseId(caseId: string): boolean {
  return CASE_ID.test(caseId);
}

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
const invalid = (message: string, fieldPath: string): EvidenceServiceError => new EvidenceServiceError(400, 'EVIDENCE_RECORD_INVALID', message, fieldPath);
const unresolved = (message: string, fieldPath: string): EvidenceServiceError => new EvidenceServiceError(422, 'EVIDENCE_REFERENCE_INVALID', message, fieldPath);

// ── Record validation (no database) ─────────────────────────────────────

const ENTRY_SCHEMA: Json = {
  $defs: (EVIDENCE_SCHEMA_1_0 as Json)['$defs'],
  ...((EVIDENCE_SCHEMA_1_0 as Json)['$defs']['entry'] as Json),
};
const RECORD_MEMBERS = new Set(['type', 'at', 'data', 'ext', 'agent_id', 'agent_did']);

/** Structure and the rules that need no other record. */
export function validateRecord(record: unknown, index: number, now: Date): void {
  const base = `records[${index}]`;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw invalid('record must be an object', base);
  const r = record as Json;
  for (const name of Object.keys(r).sort()) if (!RECORD_MEMBERS.has(name)) throw invalid('unknown member', `${base}.${name}`);
  if (!(RECORD_TYPES as readonly string[]).includes(r['type'])) throw invalid(`type must be one of ${RECORD_TYPES.join(', ')}`, `${base}.type`);
  for (const name of ['agent_id', 'agent_did']) {
    if (name in r && (typeof r[name] !== 'string' || !TOKEN.test(r[name]))) throw invalid('must be a token', `${base}.${name}`);
  }
  const entry: Json = {
    at: r['at'], data: r['data'], hash: ZERO_DIGEST, prev: ZERO_DIGEST, seq: 0,
    source: { authority: 'tenant', recorded_at: PLACEHOLDER_TIME }, type: r['type'],
  };
  if ('ext' in r) entry['ext'] = r['ext'];
  try {
    validate(entry, ENTRY_SCHEMA);
  } catch (err) {
    if (err instanceof VerificationFailure) throw invalid(err.message, err.fieldPath && err.fieldPath !== '$' ? `${base}.${err.fieldPath}` : base);
    throw err;
  }
  if (timestampMs(r['at']) > now.getTime() + MAX_CLOCK_SKEW_MS) throw invalid('time is in the future', `${base}.at`);
  const data = r['data'] as Json;
  const path = (p: string): string => `${base}.data.${p}`;
  switch (r['type']) {
    case 'tool_call':
      if (data['outcome'] === 'allowed') {
        if ('denial' in data) throw invalid('an allowed call has no denial', path('denial'));
        if (data['output_hash'] === null) throw invalid('an allowed call has an output hash', path('output_hash'));
      } else {
        if (data['outcome'] === 'denied' && !('denial' in data)) throw invalid('a denied call names its denial reason', path('denial'));
        if (data['outcome'] === 'error' && 'denial' in data) throw invalid('a failed call has no denial', path('denial'));
        if (data['output_hash'] !== null) throw invalid('a call that did not run has no output', path('output_hash'));
        if ((data['upstream_records'] as unknown[]).length > 0) throw invalid('a call that did not run has no upstream records', path('upstream_records'));
      }
      if ('completed_at' in data && timestampMs(data['completed_at']) < timestampMs(data['started_at'])) throw invalid('completed before it started', path('completed_at'));
      for (const name of ['input_hash', 'output_hash']) {
        if (typeof data[name] === 'string' && !data[name].startsWith('sha256:')) throw invalid('send the plain sha256 digest; it is keyed on export', path(name));
      }
      break;
    case 'policy_evaluation':
      (data['inputs'] as Json[]).forEach((item, i) => {
        if (((item['evidence'] as unknown[]).length > 0) === (item['unsourced'] === true)) {
          throw invalid('an input cites evidence or is marked unsourced, not both or neither', path(`inputs[${i}].unsourced`));
        }
      });
      break;
    case 'recommendation':
      (data['sections'] as Json[]).forEach((section, i) => {
        if (section['status'] !== 'not_available' && (section['evidence'] as unknown[]).length === 0) {
          throw invalid('a section that is not not_available must cite evidence', path(`sections[${i}].evidence`));
        }
      });
      break;
    default:
      break;
  }
}

function refsOf(type: string, data: Json): Array<[string, Json]> {
  const refs: Array<[string, Json]> = [];
  if (type === 'policy_evaluation') (data['inputs'] as Json[]).forEach((item, i) => (item['evidence'] as Json[]).forEach((ref, j) => refs.push([`data.inputs[${i}].evidence[${j}]`, ref])));
  if (type === 'recommendation') (data['sections'] as Json[]).forEach((s, i) => (s['evidence'] as Json[]).forEach((ref, j) => refs.push([`data.sections[${i}].evidence[${j}]`, ref])));
  if (type === 'disposition') {
    (data['comparisons'] as Json[]).forEach((c, i) => (c['evidence'] as Json[]).forEach((ref, j) => refs.push([`data.comparisons[${i}].evidence[${j}]`, ref])));
    refs.push(['data.hit', data['hit'] as Json]);
  }
  return refs;
}

// ── Audit chain helpers ──────────────────────────────────────────────────

interface Head {
  hash: string | null;
  timestampMs: number;
  id: string | null;
}

async function lockAndHead(tx: Sql, developerId: string): Promise<Head> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${developerId}, 0))`;
  const rows = await tx<{ id: string; hash: string; timestamp: Date | string }[]>`
    SELECT id, hash, timestamp FROM audit_entries WHERE developer_id = ${developerId}
    ORDER BY timestamp DESC, id DESC LIMIT 1`;
  const row = rows[0];
  return row ? { hash: row.hash, timestampMs: new Date(row.timestamp).getTime(), id: row.id } : { hash: null, timestampMs: 0, id: null };
}

/**
 * The next audit entry's id and time: never before the head, never ahead of
 * the clock unless the head already is, and sorting after the head when both
 * fall in the same millisecond (audit ids are otherwise not monotonic).
 */
export function nextStamp(head: Head, now: Date): { id: string; timestamp: string; timestampMs: number } {
  const ms = Math.max(now.getTime(), head.timestampMs);
  let id = newAuditEntryId();
  if (ms === head.timestampMs && head.id !== null && id <= head.id && /^alog_[0-9A-HJKMNP-TV-Z]{26}$/.test(head.id)) {
    id = `alog_${incrementBase32(head.id.slice(5))}`;
  }
  return { id, timestamp: new Date(ms).toISOString(), timestampMs: ms };
}

let counterTriggerPresent = false;

/** Current audit entry count for plan limits, from the counter table when its trigger exists. */
async function auditEntryCount(tx: Sql, developerId: string): Promise<number> {
  if (!counterTriggerPresent) {
    const rows = await tx<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_entry_counter_trg') AS present`;
    counterTriggerPresent = rows[0]?.present === true;
  }
  if (!counterTriggerPresent) {
    const rows = await tx<{ count: string }[]>`SELECT COUNT(*) AS count FROM audit_entries WHERE developer_id = ${developerId}`;
    return parseInt(rows[0]?.count ?? '0', 10);
  }
  // Initialised once, under the developer's audit lock, which every writer holds.
  const rows = await tx<{ entry_count: string }[]>`
    INSERT INTO audit_entry_counters (developer_id, entry_count)
    SELECT ${developerId}, COUNT(*) FROM audit_entries WHERE developer_id = ${developerId}
    ON CONFLICT (developer_id) DO UPDATE SET entry_count = audit_entry_counters.entry_count
    RETURNING entry_count`;
  return parseInt(rows[0]?.entry_count ?? '0', 10);
}

/** For tests: forget whether the counter trigger exists. */
export function resetCounterTriggerCache(): void {
  counterTriggerPresent = false;
}

async function planLimit(sql: Sql, developerId: string): Promise<number> {
  const plans = await sql<{ plan: string }[]>`SELECT plan FROM subscriptions WHERE developer_id = ${developerId}`;
  const planName = plans[0]?.plan ?? 'free';
  return PLAN_LIMITS[isPlanName(planName) ? planName : 'free'].auditEntries;
}

async function insertPlatformAudit(tx: Sql, fields: {
  id: string; developerId: string; action: string; metadata: Json; timestamp: string; prevHash: string | null; agentId?: string; agentDid?: string; grantId?: string;
}): Promise<string> {
  const row = {
    id: fields.id, agentId: fields.agentId ?? '', agentDid: fields.agentDid ?? '', grantId: fields.grantId ?? '', principalId: 'platform',
    developerId: fields.developerId, action: fields.action, metadata: fields.metadata, timestamp: fields.timestamp, prevHash: fields.prevHash, status: 'success',
  };
  const hash = computeAuditHash(row);
  await tx`
    INSERT INTO audit_entries (id, agent_id, agent_did, grant_id, principal_id, developer_id, action, metadata, hash, previous_hash, timestamp, status)
    VALUES (${row.id}, ${row.agentId}, ${row.agentDid}, ${row.grantId}, 'platform', ${row.developerId}, ${row.action},
            ${tx.json(row.metadata as postgres.JSONValue)}, ${hash}, ${row.prevHash}, ${row.timestamp}, 'success')`;
  return hash;
}

// ── Grants and decisions ─────────────────────────────────────────────────

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

/** The grant and its ancestors, root first (tenant scoped, bounded depth). */
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
  if (rows.length === 0) return [];
  if (rows[0]!.parent_grant_id !== null) {
    throw new EvidenceServiceError(422, 'EVIDENCE_GRANT_CHAIN_INVALID', `grant chain of ${grantId} is deeper than ${MAX_GRANT_DEPTH} or leaves this developer`);
  }
  return rows.map(({ hops: _hops, ...grant }) => grant);
}

function grantWindow(grant: GrantRow): [number, number] {
  const issued = new Date(grant.issued_at).getTime();
  let end = new Date(grant.expires_at).getTime();
  if (grant.revoked_at !== null) end = Math.min(end, new Date(grant.revoked_at).getTime());
  return [issued, end];
}

const DECISION_COLUMNS = ['jti', 'developer_id', 'case_id', 'approver_sub', 'approver_auth', 'dwell_ms', 'action_hash', 'approval_position', 'first_jti', 'claims', 'issued_at', 'expires_at', 'consumed_at', 'request_id'];

interface DecisionRow {
  jti: string;
  approver_sub: string;
  approver_auth: string;
  dwell_ms: number;
  action_hash: string;
  approval_position: number;
  first_jti: string | null;
  claims: unknown;
  issued_at: Date | string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  request_id: string;
  approvals_required: number;
}

/**
 * Decisions come only from the decision-grant store, never from audit entries
 * a tenant could have written. Until that store exists (or if its shape is
 * not the one this code knows), no decisions are included.
 */
async function loadDecisions(sql: Sql, developerId: string, caseId: string): Promise<{ available: boolean; rows: DecisionRow[] }> {
  try {
    const columns = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name IN ('decision_grants', 'decision_requests')`;
    const grantColumns = new Set(columns.filter((c) => c.table_name === 'decision_grants').map((c) => c.column_name));
    const requestColumns = new Set(columns.filter((c) => c.table_name === 'decision_requests').map((c) => c.column_name));
    if (!DECISION_COLUMNS.every((c) => grantColumns.has(c)) || !requestColumns.has('approvals_required')) return { available: false, rows: [] };
    const rows = await sql<DecisionRow[]>`
      SELECT g.jti, g.approver_sub, g.approver_auth, g.dwell_ms, g.action_hash, g.approval_position, g.first_jti, g.claims,
             g.issued_at, g.expires_at, g.consumed_at, g.request_id, r.approvals_required
      FROM decision_grants g JOIN decision_requests r ON r.id = g.request_id AND r.developer_id = g.developer_id
      WHERE g.developer_id = ${developerId} AND g.case_id = ${caseId}
      ORDER BY g.issued_at ASC, g.jti ASC`;
    return { available: true, rows };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), developerId, caseId }, 'decision grants unavailable for evidence export; decisions excluded');
    return { available: false, rows: [] };
  }
}

interface Sourced {
  record: Json;
  recordedMs: number;
  rank: number;
}

function decisionRecords(rows: DecisionRow[], caseId: string, issuer: string): Sourced[] {
  const out: Sourced[] = [];
  const trusted = new Map<string, DecisionRow>();
  for (const row of rows) {
    const claims = (typeof row.claims === 'string' ? JSON.parse(row.claims) : row.claims) as Json | null;
    const action = claims?.['action'] as Json | undefined;
    if (!action || action['case_id'] !== caseId || decisionActionHash(action) !== row.action_hash) {
      logger.warn({ jti: row.jti, caseId }, 'decision grant excluded from evidence: its action does not match its hash');
      continue;
    }
    trusted.set(row.jti, row);
    const data: Json = {
      action, action_hash: row.action_hash, approval_position: row.approval_position, approvals_required: row.approvals_required,
      approver: row.approver_sub, approver_auth: row.approver_auth, dwell_ms: row.dwell_ms, expires_at: iso(row.expires_at),
      issued_at: iso(row.issued_at), issuer: typeof claims?.['iss'] === 'string' ? claims['iss'] : issuer, jti: row.jti, request_id: row.request_id,
    };
    if (row.first_jti !== null) data['first_jti'] = row.first_jti;
    out.push({ record: { at: iso(row.issued_at), data, source: { authority: 'platform', recorded_at: iso(row.issued_at) }, type: 'decision' }, recordedMs: new Date(row.issued_at).getTime(), rank: 1 });
  }
  const consumed = new Map<string, DecisionRow[]>();
  for (const row of trusted.values()) {
    if (row.consumed_at === null) continue;
    const key = `${row.request_id}\n${iso(row.consumed_at)}`;
    consumed.set(key, [...(consumed.get(key) ?? []), row]);
  }
  for (const group of consumed.values()) {
    const first = group[0]!;
    if (group.length !== first.approvals_required) continue; // an incomplete presentation is not a consumption
    group.sort((a, b) => a.approval_position - b.approval_position);
    const at = iso(first.consumed_at!);
    out.push({
      record: { at, data: { action_hash: first.action_hash, consumed_at: at, jtis: group.map((g) => g.jti) }, source: { authority: 'platform', recorded_at: at }, type: 'decision_consumption' },
      recordedMs: new Date(first.consumed_at!).getTime(),
      rank: 2,
    });
  }
  return out;
}

// ── Records ──────────────────────────────────────────────────────────────

export interface AppendedRecord {
  audit_entry_id: string;
  hash: string;
  duplicate: boolean;
}

interface StoredRecord {
  record_type: string;
  record_key: string;
  content_hash: string;
  data: Json;
  audit_entry_id: string;
  voided_at: Date | string | null;
}

const recordKeyOf = (type: string, key: string): string => `${type}\n${key}`;

async function caseState(tx: Sql, developerId: string, caseId: string): Promise<{ grantLeafId: string | null; firstExportedAt: Date | null }> {
  await tx`INSERT INTO evidence_cases (developer_id, case_id) VALUES (${developerId}, ${caseId}) ON CONFLICT DO NOTHING`;
  const rows = await tx<{ grant_leaf_id: string | null; first_exported_at: Date | string | null }[]>`
    SELECT grant_leaf_id, first_exported_at FROM evidence_cases WHERE developer_id = ${developerId} AND case_id = ${caseId} FOR UPDATE`;
  const row = rows[0];
  return { grantLeafId: row?.grant_leaf_id ?? null, firstExportedAt: row?.first_exported_at ? new Date(row.first_exported_at) : null };
}

async function loadStoredRecords(tx: Sql, developerId: string, caseId: string, keys: Array<[string, string]>): Promise<Map<string, StoredRecord>> {
  const map = new Map<string, StoredRecord>();
  if (keys.length === 0) return map;
  const types = [...new Set(keys.map(([type]) => type))];
  const ids = [...new Set(keys.map(([, key]) => key))];
  const rows = await tx<StoredRecord[]>`
    SELECT record_type, record_key, content_hash, data, audit_entry_id, voided_at FROM evidence_records
    WHERE developer_id = ${developerId} AND case_id = ${caseId} AND record_type = ANY(${types}) AND record_key = ANY(${ids})`;
  for (const row of rows) map.set(recordKeyOf(row.record_type, row.record_key), row);
  return map;
}

/** Validate every record, then append them all in one transaction (all or nothing). */
export async function appendEvidenceRecords(sql: Sql, developerId: string, caseId: string, records: unknown, now: () => Date = () => new Date()): Promise<AppendedRecord[]> {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RECORDS_PER_REQUEST) {
    evidenceRecordsTotal.inc({ outcome: 'rejected' });
    throw invalid(`records must be an array of 1 to ${MAX_RECORDS_PER_REQUEST} records`, 'records');
  }
  try {
    records.forEach((record, index) => validateRecord(record, index, now()));
  } catch (err) {
    evidenceRecordsTotal.inc({ outcome: 'rejected' }, records.length);
    throw err;
  }
  const typed = records as Json[];
  const limit = await planLimit(sql, developerId);
  const appended: AppendedRecord[] = [];
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      let head = await lockAndHead(tx, developerId);
      const state = await caseState(tx, developerId, caseId);
      const referenced: Array<[string, string]> = [];
      for (const r of typed) {
        referenced.push([r['type'], r['data'][ID_FIELDS[r['type']]!]]);
        if (typeof r['data']['run_id'] === 'string' && r['type'] !== 'run_context') referenced.push(['run_context', r['data']['run_id']]);
        for (const [, ref] of refsOf(r['type'], r['data'])) referenced.push(['tool_call', ref['call_id']]);
        for (const id of (r['data']['evaluation_ids'] ?? []) as string[]) referenced.push(['policy_evaluation', id]);
      }
      const known = await loadStoredRecords(tx, developerId, caseId, referenced);
      const consumed = await caseConsumed(tx, developerId, caseId);
      let count = await auditEntryCount(tx, developerId);
      const chains = new Map<string, GrantRow[]>();
      let leaf = state.grantLeafId;

      for (const [index, record] of typed.entries()) {
        const type = record['type'] as string;
        const data = record['data'] as Json;
        const key = data[ID_FIELDS[type]!] as string;
        const content = { at: record['at'], data, ...('ext' in record ? { ext: record['ext'] } : {}), type };
        const contentHash = digest(content);
        const existing = known.get(recordKeyOf(type, key));
        if (existing) {
          if (existing.content_hash !== contentHash) {
            throw new EvidenceServiceError(409, 'EVIDENCE_RECORD_CONFLICT', `${type} ${key} was already recorded with different content`, `records[${index}]`);
          }
          const auditRows = await tx<{ hash: string }[]>`SELECT hash FROM audit_entries WHERE id = ${existing.audit_entry_id} AND developer_id = ${developerId}`;
          appended.push({ audit_entry_id: existing.audit_entry_id, hash: auditRows[0]?.hash ?? '', duplicate: true });
          continue;
        }
        const base = `records[${index}]`;
        const live = (kind: string, id: string, path: string): Json => {
          const found = known.get(recordKeyOf(kind, id));
          if (!found) throw unresolved(`no ${kind} ${id} has been recorded on this case`, `${base}.${path}`);
          if (found.voided_at !== null) throw unresolved(`${kind} ${id} is void`, `${base}.${path}`);
          return found.data;
        };
        if (typeof data['run_id'] === 'string' && type !== 'run_context') live('run_context', data['run_id'], 'data.run_id');
        if (type === 'tool_call') {
          let chain = chains.get(data['grant_id']);
          if (!chain) {
            chain = await loadGrantChain(tx, developerId, data['grant_id']);
            chains.set(data['grant_id'], chain);
          }
          if (chain.length === 0) throw unresolved('no such grant for this developer', `${base}.data.grant_id`);
          const ids = chain.map((g) => g.id);
          if (leaf === null || ids.includes(leaf)) {
            leaf = data['grant_id'];
          } else {
            let leafChain = chains.get(leaf);
            if (!leafChain) {
              leafChain = await loadGrantChain(tx, developerId, leaf);
              chains.set(leaf, leafChain);
            }
            if (!leafChain.some((g) => g.id === data['grant_id'])) {
              throw new EvidenceServiceError(422, 'EVIDENCE_GRANT_CHAIN_AMBIGUOUS', 'this grant is not on the delegation chain the case already uses', `${base}.data.grant_id`);
            }
          }
          if (data['outcome'] === 'allowed') {
            const [issued, end] = grantWindow(chain[chain.length - 1]!);
            const at = timestampMs(record['at']);
            if (at < issued - MAX_CLOCK_SKEW_MS || at > end + MAX_CLOCK_SKEW_MS) {
              throw new EvidenceServiceError(422, 'EVIDENCE_OUTSIDE_GRANT_VALIDITY', "an allowed call falls outside its grant's validity", `${base}.at`);
            }
          }
        }
        for (const [path, ref] of refsOf(type, data)) {
          const call = live('tool_call', ref['call_id'], `${path}.call_id`);
          if (call['provider'] !== ref['provider']) throw unresolved('evidence provider differs from the tool call', `${base}.${path}.provider`);
          const upstream = call['upstream_records'] as Json[];
          if (!upstream.some((u) => u['record_id'] === ref['record_id'] && u['retrieved_at'] === ref['retrieved_at'])) {
            throw unresolved('the tool call returned no such upstream record', `${base}.${path}.record_id`);
          }
        }
        ((data['evaluation_ids'] ?? []) as string[]).forEach((id, i) => live('policy_evaluation', id, `data.evaluation_ids[${i}]`));

        if (count + 1 > limit) throw new EvidenceServiceError(402, 'PLAN_LIMIT_EXCEEDED', `Plan limit reached: the plan allows ${limit} audit entries`);
        const stamp = nextStamp(head, now());
        const late = consumed || state.firstExportedAt !== null;
        const metadata: Json = { case_id: caseId, evidence: content, [PLATFORM_MARKER]: true, recorded_at: stamp.timestamp };
        const hash = await insertPlatformAudit(tx, {
          id: stamp.id, developerId, action: `evidence.${type}`, metadata, timestamp: stamp.timestamp, prevHash: head.hash,
          ...(typeof record['agent_id'] === 'string' ? { agentId: record['agent_id'] } : {}),
          ...(typeof record['agent_did'] === 'string' ? { agentDid: record['agent_did'] } : {}),
          ...(typeof data['grant_id'] === 'string' ? { grantId: data['grant_id'] } : {}),
        });
        await tx`
          INSERT INTO evidence_records (developer_id, case_id, record_type, record_key, content_hash, data, audit_entry_id, recorded_at, late)
          VALUES (${developerId}, ${caseId}, ${type}, ${key}, ${contentHash}, ${tx.json(data as postgres.JSONValue)}, ${stamp.id}, ${stamp.timestamp}, ${late})`;
        known.set(recordKeyOf(type, key), { record_type: type, record_key: key, content_hash: contentHash, data, audit_entry_id: stamp.id, voided_at: null });
        head = { hash, timestampMs: stamp.timestampMs, id: stamp.id };
        count += 1;
        appended.push({ audit_entry_id: stamp.id, hash, duplicate: false });
      }
      if (leaf !== state.grantLeafId) {
        await tx`UPDATE evidence_cases SET grant_leaf_id = ${leaf} WHERE developer_id = ${developerId} AND case_id = ${caseId}`;
      }
    });
  } catch (err) {
    evidenceRecordsTotal.inc({ outcome: 'rejected' }, typed.length);
    throw err;
  }
  evidenceRecordsTotal.inc({ outcome: 'accepted' }, appended.filter((a) => !a.duplicate).length);
  return appended;
}

async function caseConsumed(tx: Sql, developerId: string, caseId: string): Promise<boolean> {
  const decisions = await loadDecisions(tx, developerId, caseId);
  return decisions.rows.some((row) => row.consumed_at !== null);
}

/** Void a recorded record: append a `void` entry; nothing is deleted. Idempotent for the same reason. */
export async function voidEvidenceRecord(sql: Sql, developerId: string, caseId: string, body: unknown, now: () => Date = () => new Date()): Promise<AppendedRecord> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('body must be an object', '$');
  const b = body as Json;
  for (const name of Object.keys(b).sort()) if (!['reason_code', 'target_id', 'target_type'].includes(name)) throw invalid('unknown member', name);
  if (!(VOIDABLE_TYPES as readonly string[]).includes(b['target_type'])) throw invalid(`target_type must be one of ${VOIDABLE_TYPES.join(', ')}`, 'target_type');
  for (const name of ['target_id', 'reason_code']) if (typeof b[name] !== 'string' || !TOKEN.test(b[name])) throw invalid('must be a token', name);
  const limit = await planLimit(sql, developerId);
  let result: AppendedRecord | undefined;
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const head = await lockAndHead(tx, developerId);
    await caseState(tx, developerId, caseId);
    const key = `${b['target_type'] as string}:${b['target_id'] as string}`;
    const known = await loadStoredRecords(tx, developerId, caseId, [[b['target_type'], b['target_id']], ['void', key]]);
    const target = known.get(recordKeyOf(b['target_type'], b['target_id']));
    if (!target) throw unresolved('no such record on this case', 'target_id');
    const previous = known.get(recordKeyOf('void', key));
    if (previous) {
      if (previous.data['reason_code'] !== b['reason_code']) throw new EvidenceServiceError(409, 'EVIDENCE_RECORD_CONFLICT', 'the record was already voided for another reason', 'reason_code');
      const rows = await tx<{ hash: string }[]>`SELECT hash FROM audit_entries WHERE id = ${previous.audit_entry_id} AND developer_id = ${developerId}`;
      result = { audit_entry_id: previous.audit_entry_id, hash: rows[0]?.hash ?? '', duplicate: true };
      return;
    }
    if ((await auditEntryCount(tx, developerId)) + 1 > limit) throw new EvidenceServiceError(402, 'PLAN_LIMIT_EXCEEDED', `Plan limit reached: the plan allows ${limit} audit entries`);
    const stamp = nextStamp(head, now());
    const data = { reason_code: b['reason_code'], target_id: b['target_id'], target_type: b['target_type'], voided_at: stamp.timestamp };
    const content = { at: stamp.timestamp, data, type: 'void' };
    const metadata: Json = { case_id: caseId, evidence: content, [PLATFORM_MARKER]: true, recorded_at: stamp.timestamp };
    const hash = await insertPlatformAudit(tx, { id: stamp.id, developerId, action: 'evidence.void', metadata, timestamp: stamp.timestamp, prevHash: head.hash });
    await tx`
      INSERT INTO evidence_records (developer_id, case_id, record_type, record_key, content_hash, data, audit_entry_id, recorded_at)
      VALUES (${developerId}, ${caseId}, 'void', ${key}, ${digest(content)}, ${tx.json(data as postgres.JSONValue)}, ${stamp.id}, ${stamp.timestamp})`;
    await tx`
      UPDATE evidence_records SET voided_at = ${stamp.timestamp}
      WHERE developer_id = ${developerId} AND case_id = ${caseId} AND record_type = ${b['target_type']} AND record_key = ${b['target_id']}`;
    result = { audit_entry_id: stamp.id, hash, duplicate: false };
  });
  evidenceRecordsTotal.inc({ outcome: 'accepted' });
  return result!;
}

// ── Export ───────────────────────────────────────────────────────────────

export interface ExportSigner {
  privateKey: unknown;
  kid: string;
  alg: string;
}

export interface ExportResult {
  data: Uint8Array;
  root: string;
  anchorHash: string;
  entryCount: number;
  decisionsAvailable: boolean;
}

interface CaseAuditRow {
  seq: string | number;
  record_type: string;
  record_key: string;
  content_hash: string;
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

function chainFailure(developerId: string, caseId: string, code: string, message: string, auditEntryId?: string): EvidenceServiceError {
  reportChainVerificationFailure({ source: 'source_audit', code, developerId, caseId, ...(auditEntryId ? { auditEntryId } : {}) });
  return new EvidenceServiceError(409, 'EVIDENCE_CHAIN_VERIFICATION_FAILED', message);
}

/** Records from the case's audit entries, each checked against its hash, marker and link. */
async function sourceRecords(sql: Sql, developerId: string, caseId: string): Promise<Array<{ row: CaseAuditRow; content: Json; recordedMs: number }>> {
  const rows = await sql<CaseAuditRow[]>`
    SELECT r.seq, r.record_type, r.record_key, r.content_hash,
           a.id, a.agent_id, a.agent_did, a.grant_id, a.principal_id, a.developer_id, a.action, a.metadata, a.hash, a.previous_hash, a.timestamp, a.status
    FROM evidence_records r
    JOIN audit_entries a ON a.id = r.audit_entry_id AND a.developer_id = r.developer_id
    WHERE r.developer_id = ${developerId} AND r.case_id = ${caseId}
    ORDER BY r.seq ASC
    LIMIT ${MAX_CASE_ENTRIES + 1}`;
  if (rows.length > MAX_CASE_ENTRIES) throw new EvidenceServiceError(413, 'EVIDENCE_CASE_TOO_LARGE', `a case may have at most ${MAX_CASE_ENTRIES} evidence records`);
  const out: Array<{ row: CaseAuditRow; content: Json; recordedMs: number }> = [];
  for (const row of rows) {
    const timestamp = iso(row.timestamp);
    const matched = matchStoredAuditHash({
      id: row.id, agentId: row.agent_id, agentDid: row.agent_did, grantId: row.grant_id, principalId: row.principal_id, developerId: row.developer_id,
      action: row.action, metadata: row.metadata, timestamp, prevHash: row.previous_hash, status: row.status ?? 'success',
    }, row.hash);
    const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) as Json;
    const content = metadata?.['evidence'] as Json | undefined;
    if (matched === null || row.principal_id !== 'platform' || metadata[PLATFORM_MARKER] !== true || metadata['case_id'] !== caseId
      || row.action !== `evidence.${row.record_type}` || metadata['recorded_at'] !== timestamp || !content || content['type'] !== row.record_type
      || digest(content) !== row.content_hash) {
      throw chainFailure(developerId, caseId, 'audit_content', `audit entry ${row.id} does not match its hash or its evidence record`, row.id);
    }
    out.push({ row, content, recordedMs: new Date(row.timestamp).getTime() });
  }
  // Each entry must link to an existing earlier entry of the same audit chain.
  const previous = [...new Set(rows.map((r) => r.previous_hash).filter((h): h is string => h !== null))];
  if (previous.length > 0) {
    const found = await sql<{ hash: string; timestamp: Date | string }[]>`
      SELECT hash, timestamp FROM audit_entries WHERE developer_id = ${developerId} AND hash = ANY(${previous})`;
    const times = new Map(found.map((f) => [f.hash, new Date(f.timestamp).getTime()]));
    for (const row of rows) {
      if (row.previous_hash === null) continue;
      const t = times.get(row.previous_hash);
      if (t === undefined || t > new Date(row.timestamp).getTime()) {
        throw chainFailure(developerId, caseId, 'audit_link', `audit entry ${row.id} does not link to an earlier entry of the chain`, row.id);
      }
    }
  }
  return out;
}

/** Assemble, anchor, optionally sign and return the evidence package of a case. */
export async function exportCasePackage(
  sql: Sql,
  input: { developerId: string; caseId: string; issuer: string; settings: EvidenceSettings; options: unknown; signer?: () => ExportSigner; now?: () => Date },
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

function parseOptions(options: unknown, settings: EvidenceSettings, developerId: string): { disclose: string[]; sign: boolean } {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new EvidenceServiceError(400, 'BAD_REQUEST', 'body must be an object', '$');
  const o = options as Json;
  for (const name of Object.keys(o).sort()) {
    if (name !== 'disclose' && name !== 'sign') throw new EvidenceServiceError(400, 'BAD_REQUEST', 'unknown member (the case state is derived from its decisions)', name);
  }
  const disclose = o['disclose'] ?? [];
  if (!Array.isArray(disclose) || disclose.some((c) => !(IDENTIFIER_CLASSES as readonly string[]).includes(c as string))) {
    throw new EvidenceServiceError(400, 'BAD_REQUEST', `disclose must be a list of ${IDENTIFIER_CLASSES.join(', ')}`, 'disclose');
  }
  if (o['sign'] !== undefined && typeof o['sign'] !== 'boolean') throw new EvidenceServiceError(400, 'BAD_REQUEST', 'sign must be a boolean', 'sign');
  if (disclose.length > 0 && !settings.disclosureDeveloperIds.has(developerId)) {
    throw new EvidenceServiceError(403, 'EVIDENCE_DISCLOSURE_NOT_PERMITTED', 'disclosing identifiers or content requires an operator to allow it for this developer', 'disclose');
  }
  return { disclose: [...new Set(disclose as string[])].sort(), sign: o['sign'] === true };
}

async function exportInner(sql: Sql, input: Parameters<typeof exportCasePackage>[1]): Promise<ExportResult> {
  const { developerId, caseId, issuer, settings } = input;
  const now = input.now ?? (() => new Date());
  const options = parseOptions(input.options, settings, developerId);
  const everything = options.disclose.length === IDENTIFIER_CLASSES.length;
  if (!everything && (settings.secret === null || settings.keyId === null)) {
    throw new EvidenceServiceError(503, 'EVIDENCE_PSEUDONYMISATION_KEY_MISSING', 'pseudonymisation is not configured');
  }

  const sources = await sourceRecords(sql, developerId, caseId);
  if (sources.length === 0) throw new EvidenceServiceError(404, 'EVIDENCE_CASE_NOT_FOUND', 'no evidence recorded for this case');
  const caseRows = await sql<{ grant_leaf_id: string | null; first_exported_at: Date | string | null }[]>`
    SELECT grant_leaf_id, first_exported_at FROM evidence_cases WHERE developer_id = ${developerId} AND case_id = ${caseId}`;
  const leaf = caseRows[0]?.grant_leaf_id ?? null;
  if (leaf === null) throw new EvidenceServiceError(422, 'EVIDENCE_INCOMPLETE', 'no tool call in this case names a grant');
  const chain = await loadGrantChain(sql, developerId, leaf);
  if (chain.length === 0) throw new EvidenceServiceError(422, 'EVIDENCE_GRANT_CHAIN_INVALID', 'the grant the case used no longer exists');
  const decisions = await loadDecisions(sql, developerId, caseId);
  const platform = decisionRecords(decisions.rows, caseId, issuer);
  const consumptionMs = platform.filter((p) => p.record['type'] === 'decision_consumption').map((p) => p.recordedMs);
  const firstConsumption = consumptionMs.length ? Math.min(...consumptionMs) : null;
  const firstExport = caseRows[0]?.first_exported_at ? new Date(caseRows[0].first_exported_at).getTime() : null;

  const tenant: Array<Sourced & { seq: number }> = sources.map(({ row, content, recordedMs }) => {
    const late = (firstConsumption !== null && recordedMs > firstConsumption) || (firstExport !== null && recordedMs > firstExport);
    const source: Json = { audit_entry_id: row.id, audit_hash: row.hash, authority: 'tenant', recorded_at: iso(row.timestamp) };
    if (late) source['late'] = true;
    const record: Json = { at: content['at'], data: content['data'], source, type: content['type'] };
    if ('ext' in content) record['ext'] = content['ext'];
    return { record, recordedMs, rank: 0, seq: Number(row.seq) };
  });
  const revocations: Sourced[] = chain.filter((g) => g.revoked_at !== null).map((g) => ({
    record: { at: iso(g.revoked_at!), data: { grant_id: g.id, revoked_at: iso(g.revoked_at!) }, source: { authority: 'platform', recorded_at: iso(g.revoked_at!) }, type: 'revocation' },
    recordedMs: new Date(g.revoked_at!).getTime(),
    rank: 3,
  }));
  const ordered = [...tenant, ...platform.map((p) => ({ ...p, seq: 0 })), ...revocations.map((r) => ({ ...r, seq: 0 }))]
    .sort((a, b) => a.recordedMs - b.recordedMs || a.rank - b.rank || a.seq - b.seq);
  const exportedAt = now();
  const grants: Json[] = chain.map((row, depth) => {
    const revoked = row.revoked_at === null ? null : iso(row.revoked_at);
    const expired = new Date(row.expires_at).getTime() <= exportedAt.getTime();
    return {
      at: iso(row.issued_at),
      data: {
        agent_id: row.agent_id, authorization_details: Array.isArray(row.authorization_details) ? row.authorization_details : [], depth,
        expires_at: iso(row.expires_at), grant_id: row.id, issued_at: iso(row.issued_at), parent_grant_id: depth === 0 ? null : chain[depth - 1]!.id,
        principal: row.principal_id, purpose: row.purpose, revoked_at: revoked, scopes: row.scopes,
        status: revoked !== null ? 'revoked' : expired ? 'expired' : 'active',
      },
      source: { authority: 'platform', recorded_at: iso(row.issued_at) },
      type: 'grant',
    };
  });
  const caseMember = {
    case_id: caseId, exported_at: exportedAt.toISOString(), issuer,
    state: firstConsumption !== null ? 'decided' : 'open', tenant_id: developerId,
  };

  let built;
  try {
    built = buildPackage({
      case: caseMember,
      entries: [...grants, ...ordered.map((o) => o.record)],
      privacy: everything
        ? { disclosed: options.disclose }
        : { disclosed: options.disclose, key: tenantPseudonymisationKey(settings.secret!, developerId), keyId: settings.keyId! },
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

  const limit = await planLimit(sql, developerId);
  let anchor: Json | undefined;
  await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;
    const head = await lockAndHead(tx, developerId);
    if ((await auditEntryCount(tx, developerId)) + 1 > limit) {
      throw new EvidenceServiceError(402, 'PLAN_LIMIT_EXCEEDED', `Plan limit reached: the plan allows ${limit} audit entries`);
    }
    const stamp = nextStamp(head, now());
    anchor = anchorAuditEntry(built.document, { auditEntryId: stamp.id, timestamp: stamp.timestamp, prevHash: head.hash });
    const stored = await insertPlatformAudit(tx, {
      id: stamp.id, developerId, action: 'evidence.package_exported', metadata: anchor['metadata'], timestamp: stamp.timestamp, prevHash: head.hash,
    });
    if (stored !== anchor['hash']) throw chainFailure(developerId, caseId, 'anchor_hash_mismatch', 'anchor hash does not match the audit chain layout');
    await tx`UPDATE evidence_cases SET first_exported_at = COALESCE(first_exported_at, ${stamp.timestamp}) WHERE developer_id = ${developerId} AND case_id = ${caseId}`;
  });

  let document = attachAnchor(built.document, anchor!);
  if (options.sign) {
    if (!input.signer) throw new EvidenceServiceError(503, 'EVIDENCE_SIGNING_UNAVAILABLE', 'no signing key is available');
    const signer = input.signer();
    if (signer.alg !== 'ES256' && signer.alg !== 'RS256') throw new EvidenceServiceError(503, 'EVIDENCE_SIGNING_UNAVAILABLE', `signing algorithm ${signer.alg} is not supported for evidence`);
    const key = signer.privateKey instanceof KeyObject ? signer.privateKey : (signer.privateKey as webcrypto.CryptoKey);
    const jws = await new CompactSign(signedPayload(built.root, anchor!['hash']))
      .setProtectedHeader({ alg: signer.alg, kid: signer.kid, typ: 'grantex-evidence-package+jws' })
      .sign(key);
    const [header, , signature] = jws.split('.');
    if (header !== protectedHeader(signer.alg, signer.kid)) throw new EvidenceServiceError(500, 'EVIDENCE_SIGNING_FAILED', 'unexpected JWS header encoding');
    document = attachSignature(document, { alg: signer.alg, jws: `${header}..${signature}`, kid: signer.kid });
  }
  const data = serializePackage(document);
  const check = verifyPackage(data, { expectedRoot: built.root, expectedAnchorHash: anchor!['hash'], requireAnchor: true, allowUnverifiedSignature: true });
  if (!check.ok) {
    reportChainVerificationFailure({ source: 'package', code: check.code ?? 'unknown', developerId, caseId, fieldPath: check.fieldPath });
    throw new EvidenceServiceError(409, 'EVIDENCE_CHAIN_VERIFICATION_FAILED', check.message, check.fieldPath);
  }
  return { data, root: built.root, anchorHash: anchor!['hash'] as string, entryCount: built.document['chain']['length'] as number, decisionsAvailable: decisions.available };
}
