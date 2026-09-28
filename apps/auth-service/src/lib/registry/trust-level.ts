// SPDX-License-Identifier: Apache-2.0
/**
 * Computed trust levels and flags (PRD §5.1), from the registry's records.
 *
 *   basic              self-registered
 *   verified           the provider's domain is DNS-verified
 *   attested           a counted agent.identity attestation of the agent, bound
 *                      to a key it holds, AND a counted provider.entity
 *                      attestation of its provider
 *   attested_verified  attested and verified
 *
 * An attestation counts when, at the time asked: the registry's record is
 * `accepted`; the issuer's own list last read VALID, and that read is still
 * fresh (issuer_status_fresh_until: the list's exp, the time of reading plus
 * its ttl, at most a day; a read past it fails closed, and the attestation is
 * reported in stale_attestation_ids until the list is read again); the registry's
 * acceptance entry is VALID; it has not expired; its issuer is accredited
 * for its type and not suspended; the issuer is independent of the provider
 * (its entity_id is not the provider's domain or a subdomain of it, and its
 * DID is not the provider's); and, for an agent attestation, the key it names
 * is still usable in the agent's history (evaluateAttestationKey).
 *
 * Any suspension in the chain makes the level basic for policy: the agent
 * (any status other than active), its provider (suspended_at in effect), an
 * accepted attestation of either (the issuer's list or the registry's
 * acceptance entry says SUSPENDED) or the issuer of one. Everything here
 * fails closed: an agent whose provider cannot be resolved to exactly one
 * record is never more than basic, and a database error propagates.
 *
 * Flags come from the enumerated set only. Three of them, provider_screening_hit,
 * ownership_unresolved and security_review_failed, have no source: Appendix A
 * defines no payload member an issuer could report them with, and the
 * registry does not guess one from `level` (FINDINGS G-112). They are part of
 * the vocabulary so relying parties can match on them, and are never set.
 *
 * `computeAgentTrust` and `computeProviderTrust` compute at call time and are
 * what policy reads. trust_registry.computed_trust_level is a stored snapshot
 * of the provider's level: the registry rewrites its attested half
 * (computed_attested) whenever one of its attestations changes, and a
 * trigger (migration 124) combines it with DNS verification and suspension.
 * It is for display and search, not for a policy decision.
 */
import type postgres from 'postgres';
import { queries, type TxSql } from '../../db/client.js';
import { acceptanceListIdFromUri } from './acceptance-status.js';
import { evaluateAttestationKey } from './attestation-jws.js';
import { effectiveIssuerStatus, getAccreditedIssuer, isTrustMarkType, type IssuerRecord } from './issuers.js';
import { TOKEN_STATUS } from './status-list-codec.js';

type Sql = ReturnType<typeof postgres>;

export const TRUST_LEVELS = ['basic', 'verified', 'attested', 'attested_verified'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const TRUST_FLAGS = [
  'key_compromised',
  'attestation_expiring',
  'issuer_suspended',
  'declared_limits_changed',
  'provider_screening_hit',
  'ownership_unresolved',
  'security_review_failed',
] as const;
export type TrustFlag = (typeof TRUST_FLAGS)[number];

/**
 * attestation_expiring is set while a counted attestation expires within
 * this window: thirty days, long enough for an issuer to renew through the
 * refresh route before relying parties see the level drop.
 */
export const ATTESTATION_EXPIRING_WINDOW_SECONDS = 30 * 86_400;

const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
const PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

export function combineTrustLevel(input: { verified: boolean; attested: boolean; suspended: boolean }): TrustLevel {
  if (input.suspended) return 'basic';
  if (input.attested) return input.verified ? 'attested_verified' : 'attested';
  return input.verified ? 'verified' : 'basic';
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

/**
 * Whether an issuer is independent of a provider: its entity_id's host is
 * neither the provider's domain nor under it, and its DID is not the
 * provider's. A host that cannot be read is not independent.
 */
export function issuerIndependentOfProvider(
  issuer: { entityId: string; did: string | null },
  provider: { organizationDid: string; domain: string },
): boolean {
  const host = hostOf(issuer.entityId);
  const domain = provider.domain.toLowerCase().replace(/\.$/, '');
  if (host === null || domain.length === 0) return false;
  if (host === domain || host.endsWith(`.${domain}`)) return false;
  if (issuer.did !== null && issuer.did === provider.organizationDid) return false;
  return true;
}

// --- Loading -------------------------------------------------------------------------

type Queryable = Sql | TxSql;

function handle(sql: Queryable): TxSql {
  // The pool is presented as a query-only handle; a transaction is used as is.
  return typeof (sql as Sql).begin === 'function' ? queries(sql as Sql) : sql as TxSql;
}

interface AgentRow { id: string; did: string; developerId: string; status: string }

export interface ProviderRow {
  id: string;
  organizationDid: string;
  domain: string;
  verified: boolean;
  suspendedAt: Date | null;
}

interface AttestationRow {
  id: string;
  issuerEntityId: string;
  type: string;
  keyThumbprint: string | null;
  agentId: string | null;
  declaredLimits: Record<string, unknown> | null;
  iat: Date;
  exp: Date;
  receivedAt: Date;
  state: string;
  issuerStatus: string;
  issuerStatusFreshUntil: Date;
  acceptanceListUri: string;
  acceptanceListIdx: number;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toProvider(row: Record<string, unknown>): ProviderRow {
  return {
    id: row['id'] as string,
    organizationDid: row['organization_did'] as string,
    domain: row['domain'] as string,
    verified: row['trust_level'] === 'verified' && row['verified_at'] !== null && row['verified_at'] !== undefined,
    suspendedAt: row['suspended_at'] ? toDate(row['suspended_at']) : null,
  };
}

function toAttestation(row: Record<string, unknown>): AttestationRow {
  const limits = typeof row['declared_limits'] === 'string'
    ? JSON.parse(row['declared_limits']) as Record<string, unknown>
    : (row['declared_limits'] as Record<string, unknown> | null) ?? null;
  return {
    id: row['id'] as string,
    issuerEntityId: row['issuer_entity_id'] as string,
    type: row['type'] as string,
    keyThumbprint: (row['key_thumbprint'] as string | null) ?? null,
    agentId: (row['agent_id'] as string | null) ?? null,
    declaredLimits: limits,
    iat: toDate(row['iat']),
    exp: toDate(row['exp']),
    receivedAt: toDate(row['received_at']),
    state: row['state'] as string,
    issuerStatus: row['issuer_status'] as string,
    issuerStatusFreshUntil: toDate(row['issuer_status_fresh_until']),
    acceptanceListUri: row['acceptance_list_uri'] as string,
    acceptanceListIdx: Number(row['acceptance_list_idx']),
  };
}

const PROVIDER_COLUMNS = 'id, organization_did, domain, trust_level, verified_at, suspended_at';

async function loadAgent(q: TxSql, ref: string): Promise<AgentRow | null> {
  let rows: Array<Record<string, unknown>>;
  if (ref.startsWith('did:')) {
    rows = await q`SELECT id, did, developer_id, status FROM agents WHERE did = ${ref}`;
  } else if (THUMBPRINT.test(ref)) {
    rows = await q`
      SELECT a.id, a.did, a.developer_id, a.status
      FROM agent_keys k JOIN agents a ON a.id = k.agent_id
      WHERE k.thumbprint = ${ref}`;
  } else {
    return null;
  }
  const row = rows[0];
  if (!row) return null;
  return { id: row['id'] as string, did: row['did'] as string, developerId: row['developer_id'] as string, status: row['status'] as string };
}

/**
 * The provider of an agent: the one trust_registry record of the agent's
 * developer. None, or more than one, and the agent has no provider the
 * registry can attest (FINDINGS G-111).
 */
export async function resolveAgentProvider(sql: Queryable, developerId: string): Promise<ProviderRow | null> {
  const q = handle(sql);
  const rows = await q.unsafe(
    `SELECT ${PROVIDER_COLUMNS} FROM trust_registry WHERE developer_id = $1 ORDER BY id LIMIT 2`, [developerId],
  ) as Array<Record<string, unknown>>;
  return rows.length === 1 ? toProvider(rows[0]!) : null;
}

async function loadProvider(q: TxSql, ref: string): Promise<ProviderRow | null> {
  const rows = await q.unsafe(
    `SELECT ${PROVIDER_COLUMNS} FROM trust_registry WHERE organization_did = $1 OR id = $1 LIMIT 2`, [ref],
  ) as Array<Record<string, unknown>>;
  return rows.length === 1 ? toProvider(rows[0]!) : null;
}

async function loadAttestations(q: TxSql, by: { agentId: string } | { providerId: string }): Promise<AttestationRow[]> {
  const rows = 'agentId' in by
    ? await q`SELECT * FROM registry_attestations WHERE agent_id = ${by.agentId} ORDER BY iat, received_at, id`
    : await q`SELECT * FROM registry_attestations WHERE provider_id = ${by.providerId} ORDER BY iat, received_at, id`;
  return rows.map((row) => toAttestation(row as Record<string, unknown>));
}

// --- Evaluation ------------------------------------------------------------------------

interface Evaluated {
  row: AttestationRow;
  /** Counts toward the level. */
  counted: boolean;
  /** Accepted, and suspended by its issuer's list, the registry, or its issuer being suspended. */
  suspended: boolean;
  /** Accepted, last read VALID on its issuer's list, and that read is no longer fresh. */
  statusStale: boolean;
  issuerSuspended: boolean;
  keyCompromised: boolean;
}

class Evaluator {
  private readonly issuers = new Map<string, IssuerRecord | null>();

  constructor(private readonly q: TxSql, private readonly now: Date) {}

  private async issuer(entityId: string): Promise<IssuerRecord | null> {
    if (!this.issuers.has(entityId)) {
      this.issuers.set(entityId, await getAccreditedIssuer(this.q as unknown as Sql, entityId));
    }
    return this.issuers.get(entityId)!;
  }

  private async acceptanceStatus(row: AttestationRow): Promise<number | null> {
    const listId = acceptanceListIdFromUri(row.acceptanceListUri);
    if (listId === null) return null;
    const rows = await this.q`
      SELECT status FROM registry_acceptance_entries WHERE list_id = ${listId} AND idx = ${row.acceptanceListIdx}`;
    return rows[0] ? Number(rows[0]['status']) : null;
  }

  async evaluate(row: AttestationRow, provider: ProviderRow | null): Promise<Evaluated> {
    const accepted = row.state === 'accepted';
    const issuer = await this.issuer(row.issuerEntityId);
    const issuerStatus = issuer ? effectiveIssuerStatus(issuer, this.now) : 'withdrawn';
    const issuerSuspended = accepted && issuerStatus === 'suspended';
    const accredited = issuer !== null && issuerStatus === 'active'
      && isTrustMarkType(row.type) && issuer.trustMarks.includes(row.type);
    const acceptance = await this.acceptanceStatus(row);

    let keyUsable = true;
    let keyCompromised = false;
    if (row.keyThumbprint !== null) {
      const keys = await this.q`
        SELECT agent_id, status, possession_proved_at, valid_from, valid_to
        FROM agent_keys WHERE thumbprint = ${row.keyThumbprint}`;
      const key = keys[0] && keys[0]['agent_id'] === row.agentId ? keys[0] : undefined;
      keyCompromised = accepted && key !== undefined && key['status'] === 'compromised';
      keyUsable = evaluateAttestationKey(key ? {
        status: key['status'] as string,
        possessionProvedAt: key['possession_proved_at'] ? toDate(key['possession_proved_at']) : null,
        validFrom: toDate(key['valid_from']),
        validTo: key['valid_to'] ? toDate(key['valid_to']) : null,
      } : null, this.now).usable;
    }

    const independent = issuer !== null && provider !== null
      && issuerIndependentOfProvider({ entityId: issuer.entityId, did: issuer.did }, provider);
    // A VALID read past its freshness is not relied on: the issuer may have
    // revoked since, so the attestation stops counting until it is reread.
    const statusStale = accepted && row.issuerStatus === 'valid'
      && row.issuerStatusFreshUntil.getTime() <= this.now.getTime();
    const counted = accepted
      && row.issuerStatus === 'valid'
      && !statusStale
      && acceptance === TOKEN_STATUS.VALID
      && row.exp.getTime() > this.now.getTime()
      && accredited
      && independent
      && keyUsable;
    const suspended = accepted
      && (row.issuerStatus === 'suspended' || acceptance === TOKEN_STATUS.SUSPENDED || issuerSuspended);
    return { row, counted, suspended, statusStale, issuerSuspended, keyCompromised };
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * declared_limits_changed: for some type, the newest accepted attestation of
 * the agent declares other limits than the one before it (by iat, then
 * received_at), whatever became of that one. No limits and some limits
 * differ.
 */
function declaredLimitsChanged(rows: readonly AttestationRow[]): boolean {
  const byType = new Map<string, AttestationRow[]>();
  for (const row of rows) byType.set(row.type, [...(byType.get(row.type) ?? []), row]);
  for (const list of byType.values()) {
    let newest = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]!.state === 'accepted') {
        newest = i;
        break;
      }
    }
    if (newest > 0 && canonical(list[newest]!.declaredLimits) !== canonical(list[newest - 1]!.declaredLimits)) return true;
  }
  return false;
}

function expiring(evaluated: readonly Evaluated[], now: Date): boolean {
  const limit = now.getTime() + ATTESTATION_EXPIRING_WINDOW_SECONDS * 1000;
  return evaluated.some((e) => e.counted && e.row.exp.getTime() <= limit);
}

function orderedFlags(set: Set<TrustFlag>): TrustFlag[] {
  return TRUST_FLAGS.filter((flag) => set.has(flag));
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

export interface AgentTrust {
  agent_id: string;
  agent_did: string;
  provider_did: string | null;
  level: TrustLevel;
  flags: TrustFlag[];
  /** entity_ids of the issuers of the counted attestations. */
  issuers: string[];
  /** Types of the counted attestations. */
  types: string[];
  /** Registry ids of the counted attestations. */
  attestation_ids: string[];
  /** From the newest counted agent attestation that declares limits; null when none does. */
  declared_limits: Record<string, unknown> | null;
  /**
   * Registry ids of accepted attestations that do not count because the
   * registry's last read of the issuer's list is no longer fresh
   * (status_stale): the level may rise again once the list is reread.
   */
  stale_attestation_ids: string[];
}

/**
 * The agent's computed level and flags, by its DID or by the RFC 7638
 * thumbprint of any key in its history. Null when no agent matches: the
 * caller treats that as a refusal.
 */
export async function computeAgentTrust(sql: Queryable, ref: string, now: Date = new Date()): Promise<AgentTrust | null> {
  const q = handle(sql);
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 2048) return null;
  const agent = await loadAgent(q, ref);
  if (!agent) return null;
  const provider = await resolveAgentProvider(q, agent.developerId);
  const evaluator = new Evaluator(q, now);

  const agentRows = await loadAttestations(q, { agentId: agent.id });
  const providerRows = provider ? await loadAttestations(q, { providerId: provider.id }) : [];
  const evaluated: Evaluated[] = [];
  for (const row of [...agentRows, ...providerRows]) evaluated.push(await evaluator.evaluate(row, provider));
  const counted = evaluated.filter((e) => e.counted);

  const attested = counted.some((e) => e.row.type === AGENT_IDENTITY)
    && counted.some((e) => e.row.type === PROVIDER_ENTITY);
  const suspended = agent.status !== 'active'
    || (provider?.suspendedAt != null && provider.suspendedAt.getTime() <= now.getTime())
    || evaluated.some((e) => e.suspended);

  const flags = new Set<TrustFlag>();
  if (evaluated.some((e) => e.keyCompromised)) flags.add('key_compromised');
  if (expiring(evaluated, now)) flags.add('attestation_expiring');
  if (evaluated.some((e) => e.issuerSuspended)) flags.add('issuer_suspended');
  if (declaredLimitsChanged(agentRows)) flags.add('declared_limits_changed');

  const limitsSource = [...counted].reverse().find((e) => e.row.agentId !== null && e.row.declaredLimits !== null);
  return {
    agent_id: agent.id,
    agent_did: agent.did,
    provider_did: provider?.organizationDid ?? null,
    level: combineTrustLevel({ verified: provider?.verified ?? false, attested, suspended }),
    flags: orderedFlags(flags),
    issuers: sortedUnique(counted.map((e) => e.row.issuerEntityId)),
    types: sortedUnique(counted.map((e) => e.row.type)),
    attestation_ids: sortedUnique(counted.map((e) => e.row.id)),
    declared_limits: limitsSource?.row.declaredLimits ?? null,
    stale_attestation_ids: sortedUnique(evaluated.filter((e) => e.statusStale).map((e) => e.row.id)),
  };
}

export interface ProviderTrust {
  provider_id: string;
  provider_did: string;
  /** attested here means a counted provider.entity attestation. */
  level: TrustLevel;
  flags: TrustFlag[];
  issuers: string[];
  types: string[];
  attestation_ids: string[];
  stale_attestation_ids: string[];
}

async function evaluateProvider(q: TxSql, provider: ProviderRow, now: Date): Promise<ProviderTrust> {
  const evaluator = new Evaluator(q, now);
  const evaluated: Evaluated[] = [];
  for (const row of await loadAttestations(q, { providerId: provider.id })) evaluated.push(await evaluator.evaluate(row, provider));
  const counted = evaluated.filter((e) => e.counted);
  const suspended = (provider.suspendedAt !== null && provider.suspendedAt.getTime() <= now.getTime())
    || evaluated.some((e) => e.suspended);
  const flags = new Set<TrustFlag>();
  if (expiring(evaluated, now)) flags.add('attestation_expiring');
  if (evaluated.some((e) => e.issuerSuspended)) flags.add('issuer_suspended');
  return {
    provider_id: provider.id,
    provider_did: provider.organizationDid,
    level: combineTrustLevel({
      verified: provider.verified,
      attested: counted.some((e) => e.row.type === PROVIDER_ENTITY),
      suspended,
    }),
    flags: orderedFlags(flags),
    issuers: sortedUnique(counted.map((e) => e.row.issuerEntityId)),
    types: sortedUnique(counted.map((e) => e.row.type)),
    attestation_ids: sortedUnique(counted.map((e) => e.row.id)),
    stale_attestation_ids: sortedUnique(evaluated.filter((e) => e.statusStale).map((e) => e.row.id)),
  };
}

/** The provider's computed level, by its organization DID or record id. Null when there is no such provider. */
export async function computeProviderTrust(sql: Queryable, ref: string, now: Date = new Date()): Promise<ProviderTrust | null> {
  const q = handle(sql);
  const provider = await loadProvider(q, ref);
  return provider ? evaluateProvider(q, provider, now) : null;
}

/**
 * Rewrite the attested half of one provider's stored level
 * (trust_registry.computed_attested): whether a provider.entity attestation
 * of it counts now. The trigger of migration 124 combines it with DNS
 * verification and the provider's own suspension into computed_trust_level,
 * so the provider's suspension, which the level computed here already
 * includes, is left out of the stored half.
 */
export async function recomputeProviderTrustLevel(tx: TxSql, providerId: string, now: Date = new Date()): Promise<TrustLevel | null> {
  const provider = await loadProvider(tx, providerId);
  if (!provider) return null;
  const trust = await evaluateProvider(tx, { ...provider, suspendedAt: null }, now);
  const attested = trust.level === 'attested' || trust.level === 'attested_verified';
  const rows = await tx`
    UPDATE trust_registry SET computed_attested = ${attested}
    WHERE id = ${provider.id}
    RETURNING computed_trust_level`;
  return (rows[0]?.['computed_trust_level'] as TrustLevel | undefined) ?? null;
}
