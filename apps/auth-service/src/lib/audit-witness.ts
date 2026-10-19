/**
 * Audit witness checkpoints (G16). AgenticOrg posts the head of its own
 * hash-chained audit log; this service stores it and countersigns it with the
 * platform key, so a later rewrite of that chain below a witnessed head is
 * provable by anyone holding the countersignature and the Grantex JWKS.
 *
 * Idempotent on (source, tenant_ref, chain, head_seq, head_hash): the same
 * head answers with the stored witness. A different hash for an already
 * witnessed (source, tenant_ref, chain, head_seq) is a fork: it is refused
 * (409 WITNESS_FORK), recorded in `audit_witness_forks`, and answered with
 * the stored witness as evidence.
 */
import type postgres from 'postgres';
import { SignJWT } from 'jose';
import { ulid } from 'ulid';
import { config } from '../config.js';
import { getKeyPair } from './crypto.js';

type Sql = ReturnType<typeof postgres>;

export const AUDIT_WITNESS_TYP = 'audit-witness+jwt';
export const WITNESS_SOURCES = ['agenticorg'] as const;
export const WITNESS_CHAINS = ['audit_log'] as const;
/** How far in the future `anchored_at` may be, for clock skew between the services. */
export const WITNESS_ANCHOR_SKEW_SECONDS = 300;

const TENANT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const BODY_KEYS = ['source', 'tenant_ref', 'chain', 'head_seq', 'head_hash', 'anchored_at'] as const;

export class WitnessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WitnessError';
  }
}

export interface WitnessCheckpointInput {
  source: (typeof WITNESS_SOURCES)[number];
  tenant_ref: string;
  chain: (typeof WITNESS_CHAINS)[number];
  head_seq: number;
  head_hash: string;
  /** Normalised to RFC 3339 UTC with milliseconds. */
  anchored_at: string;
}

export interface WitnessCheckpoint extends WitnessCheckpointInput {
  witness_id: string;
  witnessed_at: string;
  countersignature: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string, message: string): WitnessError {
  return new WitnessError(400, 'BAD_REQUEST', `${field}: ${message}`, { field });
}

/** Validates a posted chain head. Unknown members are refused. */
export function parseWitnessCheckpoint(raw: unknown, now: Date = new Date()): WitnessCheckpointInput {
  if (!isRecord(raw)) throw invalid('body', 'must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (!(BODY_KEYS as readonly string[]).includes(key)) throw invalid(key, 'is not a member of a witness checkpoint');
  }
  const source = raw['source'];
  if (!(WITNESS_SOURCES as readonly unknown[]).includes(source)) throw invalid('source', `must be one of ${WITNESS_SOURCES.join(', ')}`);
  const chain = raw['chain'];
  if (!(WITNESS_CHAINS as readonly unknown[]).includes(chain)) throw invalid('chain', `must be one of ${WITNESS_CHAINS.join(', ')}`);
  const tenantRef = raw['tenant_ref'];
  if (typeof tenantRef !== 'string' || !TENANT_REF_RE.test(tenantRef)) throw invalid('tenant_ref', 'is missing or malformed');
  const headSeq = raw['head_seq'];
  if (typeof headSeq !== 'number' || !Number.isSafeInteger(headSeq) || headSeq < 0) throw invalid('head_seq', 'must be a non-negative integer');
  const headHash = raw['head_hash'];
  if (typeof headHash !== 'string' || !HEX64_RE.test(headHash)) throw invalid('head_hash', 'must be lowercase hex SHA-256');
  const anchoredAt = raw['anchored_at'];
  const anchoredMs = typeof anchoredAt === 'string' && ISO_RE.test(anchoredAt) ? Date.parse(anchoredAt) : Number.NaN;
  if (!Number.isFinite(anchoredMs)) throw invalid('anchored_at', 'must be an RFC 3339 timestamp');
  if (anchoredMs > now.getTime() + WITNESS_ANCHOR_SKEW_SECONDS * 1000) throw invalid('anchored_at', 'is in the future');
  return {
    source: source as WitnessCheckpointInput['source'],
    tenant_ref: tenantRef,
    chain: chain as WitnessCheckpointInput['chain'],
    head_seq: headSeq,
    head_hash: headHash,
    anchored_at: new Date(anchoredMs).toISOString(),
  };
}

/**
 * The countersignature: a compact JWS (`typ` `audit-witness+jwt`) by the
 * platform key over the checkpoint and `witnessed_at`, verifiable with the
 * service's JWKS. It has no `exp`: it is evidence that the head was witnessed
 * at that time, not a permission.
 */
export async function signWitnessCheckpoint(checkpoint: WitnessCheckpointInput & { witness_id: string; witnessed_at: string }): Promise<string> {
  const { privateKey, kid, alg } = getKeyPair();
  return new SignJWT({
    source: checkpoint.source,
    tenant_ref: checkpoint.tenant_ref,
    chain: checkpoint.chain,
    head_seq: checkpoint.head_seq,
    head_hash: checkpoint.head_hash,
    anchored_at: checkpoint.anchored_at,
    witnessed_at: checkpoint.witnessed_at,
  })
    .setProtectedHeader({ alg, kid, typ: AUDIT_WITNESS_TYP })
    .setIssuer(config.jwtIssuer)
    .setJti(checkpoint.witness_id)
    .setIssuedAt(Math.floor(Date.parse(checkpoint.witnessed_at) / 1000))
    .sign(privateKey);
}

interface WitnessRow {
  witness_id: string;
  source: string;
  tenant_ref: string;
  chain: string;
  head_seq: string;
  head_hash: string;
  anchored_at: Date;
  witnessed_at: Date;
  countersignature: string;
}

function fromRow(row: WitnessRow): WitnessCheckpoint {
  return {
    witness_id: row.witness_id,
    source: row.source as WitnessCheckpoint['source'],
    tenant_ref: row.tenant_ref,
    chain: row.chain as WitnessCheckpoint['chain'],
    head_seq: Number(row.head_seq),
    head_hash: row.head_hash,
    anchored_at: row.anchored_at.toISOString(),
    witnessed_at: row.witnessed_at.toISOString(),
    countersignature: row.countersignature,
  };
}

async function witnessedAt(sql: Sql, input: WitnessCheckpointInput): Promise<WitnessRow | undefined> {
  const rows = await sql<WitnessRow[]>`
    SELECT witness_id, source, tenant_ref, chain, head_seq::text AS head_seq, head_hash, anchored_at, witnessed_at, countersignature
      FROM audit_witness_checkpoints
     WHERE source = ${input.source} AND tenant_ref = ${input.tenant_ref} AND chain = ${input.chain} AND head_seq = ${input.head_seq}
  `;
  return rows[0];
}

/** Refuses a fork: records the attempt beside the witnessed head and answers with both. */
async function refuseFork(sql: Sql, stored: WitnessRow, input: WitnessCheckpointInput, serviceId: string): Promise<never> {
  const forkId = `awfk_${ulid()}`;
  await sql`
    INSERT INTO audit_witness_forks (id, witness_id, source, tenant_ref, chain, head_seq, witnessed_hash, presented_hash, presented_anchored_at, service_id)
    VALUES (${forkId}, ${stored.witness_id}, ${input.source}, ${input.tenant_ref}, ${input.chain}, ${input.head_seq},
            ${stored.head_hash}, ${input.head_hash}, ${input.anchored_at}, ${serviceId})
  `;
  throw new WitnessError(409, 'WITNESS_FORK',
    'A different head_hash is already witnessed for this source, tenant_ref, chain and head_seq', {
      fork: {
        fork_id: forkId,
        source: input.source,
        tenant_ref: input.tenant_ref,
        chain: input.chain,
        head_seq: input.head_seq,
        witnessed: fromRow(stored),
        presented: { head_hash: input.head_hash, anchored_at: input.anchored_at },
      },
    });
}

/** Stores and countersigns a chain head, or answers the stored witness. */
export async function witnessCheckpoint(
  sql: Sql,
  raw: unknown,
  serviceId: string,
  now: Date = new Date(),
): Promise<{ created: boolean; checkpoint: WitnessCheckpoint }> {
  const input = parseWitnessCheckpoint(raw, now);
  const existing = await witnessedAt(sql, input);
  if (existing) {
    if (existing.head_hash !== input.head_hash) return refuseFork(sql, existing, input, serviceId);
    return { created: false, checkpoint: fromRow(existing) };
  }
  const witnessId = `awit_${ulid()}`;
  const witnessedAtIso = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const countersignature = await signWitnessCheckpoint({ ...input, witness_id: witnessId, witnessed_at: witnessedAtIso });
  const inserted = await sql<WitnessRow[]>`
    INSERT INTO audit_witness_checkpoints (witness_id, source, tenant_ref, chain, head_seq, head_hash, anchored_at, witnessed_at, countersignature, service_id)
    VALUES (${witnessId}, ${input.source}, ${input.tenant_ref}, ${input.chain}, ${input.head_seq}, ${input.head_hash},
            ${input.anchored_at}, ${witnessedAtIso}, ${countersignature}, ${serviceId})
    ON CONFLICT (source, tenant_ref, chain, head_seq) DO NOTHING
    RETURNING witness_id, source, tenant_ref, chain, head_seq::text AS head_seq, head_hash, anchored_at, witnessed_at, countersignature
  `;
  if (inserted[0]) return { created: true, checkpoint: fromRow(inserted[0]) };
  // A concurrent post of the same head_seq won the insert.
  const raced = await witnessedAt(sql, input);
  if (!raced) throw new Error('witness checkpoint insert conflicted but no row exists');
  if (raced.head_hash !== input.head_hash) return refuseFork(sql, raced, input, serviceId);
  return { created: false, checkpoint: fromRow(raced) };
}

/** The witnessed heads of one tenant's chain, newest first, and any recorded forks. */
export async function listWitnessCheckpoints(
  sql: Sql,
  query: { source: unknown; tenant_ref: unknown; limit?: unknown },
): Promise<{ checkpoints: WitnessCheckpoint[]; forks: Record<string, unknown>[] }> {
  if (!(WITNESS_SOURCES as readonly unknown[]).includes(query.source)) throw invalid('source', `must be one of ${WITNESS_SOURCES.join(', ')}`);
  if (typeof query.tenant_ref !== 'string' || !TENANT_REF_RE.test(query.tenant_ref)) throw invalid('tenant_ref', 'is missing or malformed');
  let limit = 100;
  if (query.limit !== undefined) {
    const n = Number(query.limit);
    if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw invalid('limit', 'must be an integer between 1 and 500');
    limit = n;
  }
  const rows = await sql<WitnessRow[]>`
    SELECT witness_id, source, tenant_ref, chain, head_seq::text AS head_seq, head_hash, anchored_at, witnessed_at, countersignature
      FROM audit_witness_checkpoints
     WHERE source = ${query.source as string} AND tenant_ref = ${query.tenant_ref}
     ORDER BY head_seq DESC, witness_id DESC
     LIMIT ${limit}
  `;
  const forks = await sql<Record<string, unknown>[]>`
    SELECT id AS fork_id, witness_id, chain, head_seq::text AS head_seq, witnessed_hash, presented_hash, presented_anchored_at, detected_at
      FROM audit_witness_forks
     WHERE source = ${query.source as string} AND tenant_ref = ${query.tenant_ref}
     ORDER BY detected_at DESC, id DESC
     LIMIT ${limit}
  `;
  return {
    checkpoints: rows.map(fromRow),
    forks: forks.map((f) => ({
      ...f,
      head_seq: Number(f['head_seq']),
      presented_anchored_at: (f['presented_anchored_at'] as Date).toISOString(),
      detected_at: (f['detected_at'] as Date).toISOString(),
    })),
  };
}
