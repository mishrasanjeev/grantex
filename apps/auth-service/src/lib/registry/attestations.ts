// SPDX-License-Identifier: Apache-2.0
/**
 * Attestations in the registry (PRD §5 Attestation, §7 Attestation, §8.3,
 * Appendix A): ingestion, withdrawal, refresh and the recheck of an issuer's
 * status list. The routes are in routes/registry-attestations.ts; the checks
 * that need no database are in attestation-jws.ts; levels and flags are in
 * trust-level.ts.
 *
 * An attestation is posted by nobody but its issuer's signature: the route
 * has no API key, and the registry accepts it only when, in this order (each
 * step refusing with its Appendix C code, spec/attestation-1.0.md §5):
 *
 *   1. it is a compact JWS;
 *   2. its header has typ grantex-attestation+jwt, alg ES256 (EdDSA only
 *      when REGISTRY_ATTESTATION_EDDSA_ENABLED=true) and a kid;
 *   3. its issuer is accredited for its type and not suspended now;
 *   4. it verifies with that issuer's key for kid, from the registry's
 *      static record only (owner decision 7);
 *   5. every payload member has its Appendix A type;
 *   6. its sub is a registered agent (agent.* types) or provider (provider.*);
 *   7. for an agent, key_thumbprint is a key of that agent whose possession
 *      has been proven (possession before attestation);
 *   8. external_credential_hash follows the hash rule;
 *   9. it has not expired, and exp is after iat;
 *  10. its status list URI is under the issuer's status_list_base (owner
 *      decision 8) and the issuer's list, fetched now and signed by the same
 *      issuer's keys, is fresh and shows the entry VALID.
 *
 * Before step 2, a post whose bytes equal a record already stored for the
 * same issuer and id is answered with that record and not verified again:
 * those bytes were verified when first accepted, and an issuer retrying
 * after a timeout must not be refused because its list is briefly
 * unreachable. Any other post goes through every step; then a transaction
 * checks for a duplicate (the same issuer and id with other bytes is a
 * conflict), stores the JWS exactly as received, allocates the registry's
 * acceptance entry (VALID), audits the change on the registry chain and
 * recomputes the provider's stored level. Nothing is written for a refusal,
 * and the network fetch happens before the transaction opens, so a slow
 * issuer never holds a registry lock.
 *
 * The issuer's list is read at acceptance and then again before each read
 * goes stale (issuer_status_fresh_until, workers/registryIssuerStatusRecheck.ts).
 * A read past its freshness no longer counts toward a level.
 */
import type postgres from 'postgres';
import { config } from '../../config.js';
import { queries, type TxSql } from '../../db/client.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { newRegistryAttestationId } from '../ids.js';
import { allocateAcceptanceEntry, setAcceptance } from './acceptance-status.js';
import {
  AttestationError,
  CLOCK_SKEW_SECONDS,
  REQUEST_MAX_AGE_SECONDS,
  checkAttestationHeader,
  checkAttestationTimes,
  checkExternalCredentialHash,
  evaluateAttestationKey,
  parseAttestationPayload,
  parseCompactJws,
  readIssuerAndType,
  readStatusListEntry,
  statusUriUnderBase,
  verifyAttestationRequest,
  verifyJwsSignature,
  type AttestationClaims,
  type AttestationRequestAction,
} from './attestation-jws.js';
import { IssuerFetchError, fetchIssuerStatusList } from './issuer-fetcher.js';
import { TOKEN_STATUS } from './status-list-codec.js';
import {
  REGISTRY_AUDIT_CHAIN,
  getAccreditedIssuer,
  isAccreditedFor,
  issuerVerificationKey,
  type IssuerRecord,
} from './issuers.js';
import { recomputeProviderTrustLevel } from './trust-level.js';

type Sql = ReturnType<typeof postgres>;

export type IssuerStatus = 'valid' | 'revoked' | 'suspended';

/** Who asked for a withdrawal or refresh. */
export type RegistryActor =
  | { kind: 'operator'; requestedBy: string }
  | { kind: 'issuer'; request: string };

export interface AttestationRecord {
  id: string;
  issuerId: string;
  issuerEntityId: string;
  attestationId: string;
  jws: string;
  receivedAt: Date;
  sub: string;
  subjectKind: 'agent' | 'provider';
  agentId: string | null;
  providerId: string | null;
  type: string;
  keyThumbprint: string | null;
  externalCredentialId: string;
  externalCredentialHash: string;
  level: string;
  declaredLimits: Record<string, unknown> | null;
  iat: Date;
  exp: Date;
  statusListUri: string;
  statusListIdx: number;
  acceptanceListUri: string;
  acceptanceListIdx: number;
  state: 'accepted' | 'withdrawn' | 'superseded';
  issuerStatus: IssuerStatus;
  /** When the registry last tried to read the issuer's list, successfully or not. */
  issuerStatusCheckedAt: Date;
  /** Until when the last successful read may be relied on. */
  issuerStatusFreshUntil: Date;
  supersedes: string | null;
  supersededBy: string | null;
  withdrawnAt: Date | null;
  supersededAt: Date | null;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function optionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function toRecord(row: Record<string, unknown>): AttestationRecord {
  const limits = typeof row['declared_limits'] === 'string'
    ? JSON.parse(row['declared_limits']) as Record<string, unknown>
    : (row['declared_limits'] as Record<string, unknown> | null) ?? null;
  return {
    id: row['id'] as string,
    issuerId: row['issuer_id'] as string,
    issuerEntityId: row['issuer_entity_id'] as string,
    attestationId: row['attestation_id'] as string,
    jws: row['jws'] as string,
    receivedAt: toDate(row['received_at']),
    sub: row['sub'] as string,
    subjectKind: row['subject_kind'] as 'agent' | 'provider',
    agentId: (row['agent_id'] as string | null) ?? null,
    providerId: (row['provider_id'] as string | null) ?? null,
    type: row['type'] as string,
    keyThumbprint: (row['key_thumbprint'] as string | null) ?? null,
    externalCredentialId: row['external_credential_id'] as string,
    externalCredentialHash: row['external_credential_hash'] as string,
    level: row['level'] as string,
    declaredLimits: limits,
    iat: toDate(row['iat']),
    exp: toDate(row['exp']),
    statusListUri: row['status_list_uri'] as string,
    statusListIdx: Number(row['status_list_idx']),
    acceptanceListUri: row['acceptance_list_uri'] as string,
    acceptanceListIdx: Number(row['acceptance_list_idx']),
    state: row['state'] as AttestationRecord['state'],
    issuerStatus: row['issuer_status'] as IssuerStatus,
    issuerStatusCheckedAt: toDate(row['issuer_status_checked_at']),
    issuerStatusFreshUntil: toDate(row['issuer_status_fresh_until']),
    supersedes: (row['supersedes'] as string | null) ?? null,
    supersededBy: (row['superseded_by'] as string | null) ?? null,
    withdrawnAt: optionalDate(row['withdrawn_at']),
    supersededAt: optionalDate(row['superseded_at']),
  };
}

/** The record as the routes return it: the registry's vocabulary, snake_case; never the JWS itself. */
export function toPublicAttestation(record: AttestationRecord) {
  return {
    id: record.id,
    iss: record.issuerEntityId,
    attestation_id: record.attestationId,
    sub: record.sub,
    type: record.type,
    level: record.level,
    key_thumbprint: record.keyThumbprint,
    external_credential_id: record.externalCredentialId,
    external_credential_hash: record.externalCredentialHash,
    declared_limits: record.declaredLimits,
    iat: record.iat.toISOString(),
    exp: record.exp.toISOString(),
    status: { status_list: { uri: record.statusListUri, idx: record.statusListIdx } },
    acceptance: { status_list: { uri: record.acceptanceListUri, idx: record.acceptanceListIdx } },
    state: record.state,
    issuer_status: record.issuerStatus,
    received_at: record.receivedAt.toISOString(),
    supersedes: record.supersedes,
    superseded_by: record.supersededBy,
    withdrawn_at: record.withdrawnAt?.toISOString() ?? null,
  };
}

async function selectRecord(q: TxSql, id: string, forUpdate = false): Promise<AttestationRecord | null> {
  const rows = forUpdate
    ? await q`SELECT * FROM registry_attestations WHERE id = ${id} FOR UPDATE`
    : await q`SELECT * FROM registry_attestations WHERE id = ${id}`;
  return rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
}

/** A registry attestation by its registry id, or null. */
export async function getAttestation(sql: Sql, id: string): Promise<AttestationRecord | null> {
  if (typeof id !== 'string' || !/^ratt_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  return selectRecord(queries(sql), id);
}

// --- Verification ------------------------------------------------------------------------

interface Subject {
  kind: 'agent' | 'provider';
  agentId: string | null;
  providerId: string | null;
}

export interface VerifiedAttestation {
  compact: string;
  claims: AttestationClaims;
  issuer: IssuerRecord;
  subject: Subject;
  /** Until when the issuer's VALID, read during verification, may be relied on. */
  issuerStatusFreshUntil: Date;
}

async function resolveSubject(q: TxSql, claims: AttestationClaims): Promise<Subject> {
  if (claims.subjectKind === 'agent') {
    const rows = await q`SELECT id FROM agents WHERE did = ${claims.sub}`;
    if (rows[0]) return { kind: 'agent', agentId: rows[0]['id'] as string, providerId: null };
  } else {
    const rows = await q`SELECT id FROM trust_registry WHERE organization_did = ${claims.sub}`;
    if (rows[0]) return { kind: 'provider', agentId: null, providerId: rows[0]['id'] as string };
  }
  throw new AttestationError('attestation_mismatch', 'subject_not_registered',
    `sub is not a registered ${claims.subjectKind === 'agent' ? 'agent' : 'provider'}`);
}

/**
 * Possession before attestation: the key must be in this agent's history,
 * proven and usable now. A key of another agent reads exactly like an
 * unknown one, so the answer does not say who holds it.
 */
async function checkAttestedKey(q: TxSql, agentId: string, thumbprint: string, now: Date, lock = false): Promise<void> {
  const rows = lock
    ? await q`SELECT status, possession_proved_at, valid_from, valid_to FROM agent_keys
              WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId} FOR SHARE`
    : await q`SELECT status, possession_proved_at, valid_from, valid_to FROM agent_keys
              WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId}`;
  const row = rows[0];
  const result = evaluateAttestationKey(row ? {
    status: row['status'] as string,
    possessionProvedAt: optionalDate(row['possession_proved_at']),
    validFrom: toDate(row['valid_from']),
    validTo: optionalDate(row['valid_to']),
  } : null, now);
  if (!result.usable) {
    throw new AttestationError(result.denial, result.denial, result.denial === 'key_unproven'
      ? 'key_thumbprint is not a key of this agent whose possession has been proven'
      : 'key_thumbprint names a key that is compromised or no longer active');
  }
}

/**
 * Read the issuer's Token Status List entry now, whatever its value. Every
 * way of failing to read it is status_stale.
 */
async function readIssuerStatusList(
  sql: Sql,
  issuer: IssuerRecord,
  uri: string,
  idx: number,
  now: Date,
): Promise<{ value: number; freshUntil: Date }> {
  if (!statusUriUnderBase(uri, issuer.statusListBase)) {
    throw new AttestationError('status_stale', 'status_list_not_under_base',
      'status.status_list.uri is not under the issuer\'s status_list_base');
  }
  let token: string;
  try {
    token = await fetchIssuerStatusList(uri);
  } catch (err) {
    // An unreadable list is a refusal, never an accepted attestation.
    if (err instanceof IssuerFetchError) throw new AttestationError('status_stale', 'unreachable', err.message);
    throw err;
  }
  return readStatusListEntry(token, {
    uri,
    idx,
    now,
    resolveKey: (kid) => issuerVerificationKey(sql, issuer.entityId, kid),
    eddsaEnabled: config.registryAttestationEddsaEnabled,
  });
}

/** What the registry records for an entry's value. Anything but VALID or SUSPENDED is revoked: fail closed. */
function issuerStatusOf(value: number): IssuerStatus {
  if (value === TOKEN_STATUS.VALID) return 'valid';
  if (value === TOKEN_STATUS.SUSPENDED) return 'suspended';
  return 'revoked';
}

/**
 * readIssuerStatusList, requiring the entry to be VALID: otherwise
 * passport_revoked. Returns until when the read stays fresh.
 */
async function checkIssuerStatusList(sql: Sql, issuer: IssuerRecord, uri: string, idx: number, now: Date): Promise<Date> {
  const read = await readIssuerStatusList(sql, issuer, uri, idx, now);
  const status = issuerStatusOf(read.value);
  if (status === 'valid') return read.freshUntil;
  if (status === 'suspended') throw new AttestationError('passport_revoked', 'suspended', 'the issuer has suspended this attestation');
  if (read.value === TOKEN_STATUS.INVALID) throw new AttestationError('passport_revoked', 'invalid', 'the issuer has revoked this attestation');
  throw new AttestationError('passport_revoked', 'not_valid',
    `the issuer's status for this attestation is 0x${read.value.toString(16)}, not VALID`);
}

/** Steps 1 to 10 of the module comment. Reads only; throws AttestationError for every refusal. */
export async function verifyAttestation(sql: Sql, compact: unknown, now: Date = new Date()): Promise<VerifiedAttestation> {
  const q = queries(sql);
  const parsed = parseCompactJws(compact);
  const { alg, kid } = checkAttestationHeader(parsed.header, { eddsaEnabled: config.registryAttestationEddsaEnabled });
  const { iss, type } = readIssuerAndType(parsed.payload);
  const accreditation = await isAccreditedFor(sql, iss, type, now);
  if (!accreditation.accredited) {
    throw new AttestationError(accreditation.code, accreditation.code, `the issuer is not accredited for ${type} now`);
  }
  await verifyJwsSignature(compact as string, await issuerVerificationKey(sql, iss, kid), alg);
  const claims = parseAttestationPayload(parsed.payload);
  const subject = await resolveSubject(q, claims);
  if (subject.kind === 'agent') await checkAttestedKey(q, subject.agentId!, claims.keyThumbprint!, now);
  checkExternalCredentialHash(claims.externalCredentialHash);
  checkAttestationTimes(claims, now);
  const issuer = await getAccreditedIssuer(sql, iss);
  // isAccreditedFor has just read it; a record that vanished since is a refusal.
  if (!issuer) throw new AttestationError('issuer_not_accredited', 'issuer_not_accredited', 'the issuer is not in the registry');
  const issuerStatusFreshUntil = await checkIssuerStatusList(sql, issuer, claims.statusListUri, claims.statusListIdx, now);
  return { compact: compact as string, claims, issuer, subject, issuerStatusFreshUntil };
}

// --- Writes ------------------------------------------------------------------------------

async function insertRecord(tx: TxSql, verified: VerifiedAttestation, supersedes: string | null, now: Date): Promise<AttestationRecord> {
  const { claims, issuer, subject } = verified;
  const acceptance = await allocateAcceptanceEntry(tx);
  const id = newRegistryAttestationId();
  await tx`
    INSERT INTO registry_attestations (
      id, issuer_id, issuer_entity_id, attestation_id, jws, sub, subject_kind, agent_id, provider_id, type,
      key_thumbprint, external_credential_id, external_credential_hash, level, declared_limits, iat, exp,
      status_list_uri, status_list_idx, acceptance_list_uri, acceptance_list_idx, supersedes,
      issuer_status_checked_at, issuer_status_fresh_until
    ) VALUES (
      ${id}, ${issuer.id}, ${claims.iss}, ${claims.id}, ${verified.compact}, ${claims.sub}, ${subject.kind},
      ${subject.agentId}, ${subject.providerId}, ${claims.type}, ${claims.keyThumbprint}, ${claims.externalCredentialId},
      ${claims.externalCredentialHash}, ${claims.level},
      ${claims.declaredLimits === null ? null : tx.json(claims.declaredLimits as postgres.JSONValue)},
      ${new Date(claims.iat * 1000)}, ${new Date(claims.exp * 1000)},
      ${claims.statusListUri}, ${claims.statusListIdx}, ${acceptance.uri}, ${acceptance.idx}, ${supersedes},
      ${now}, ${verified.issuerStatusFreshUntil}
    )`;
  const record = await selectRecord(tx, id);
  if (!record) throw new Error('attestation vanished inside its own transaction');
  return record;
}

function auditMetadata(record: AttestationRecord, requestedBy: string): Record<string, unknown> {
  return {
    attestationId: record.id,
    issuerEntityId: record.issuerEntityId,
    issuerAttestationId: record.attestationId,
    sub: record.sub,
    type: record.type,
    requestedBy,
  };
}

async function recompute(tx: TxSql, record: AttestationRecord, now: Date): Promise<void> {
  if (record.providerId !== null) await recomputeProviderTrustLevel(tx, record.providerId, now);
}

/**
 * The stored record whose JWS is exactly these bytes, found by the payload's
 * iss and id; null for anything else. The bytes are not verified here: only
 * an exact match with bytes the registry verified and stored is answered,
 * and everything else goes on to full verification, which reports the
 * refusal. So nothing is accepted on this path that was not accepted before.
 */
async function findReplay(sql: Sql, compact: unknown): Promise<AttestationRecord | null> {
  if (typeof compact !== 'string') return null;
  let payload: Record<string, unknown>;
  try {
    payload = parseCompactJws(compact).payload;
  } catch (err) {
    // Not a compact JWS, so not a replay; verifyAttestation refuses it with its code.
    if (err instanceof AttestationError) return null;
    throw err;
  }
  const iss = payload['iss'];
  const id = payload['id'];
  if (typeof iss !== 'string' || typeof id !== 'string') return null;
  const rows = await queries(sql)`
    SELECT * FROM registry_attestations WHERE issuer_entity_id = ${iss} AND attestation_id = ${id}`;
  const record = rows[0] ? toRecord(rows[0] as Record<string, unknown>) : null;
  return record !== null && record.jws === compact ? record : null;
}

/** Accept a posted attestation. `created` is false for a replay of the same bytes. */
export async function ingestAttestation(
  sql: Sql,
  compact: unknown,
  now: Date = new Date(),
): Promise<{ record: AttestationRecord; created: boolean }> {
  const replay = await findReplay(sql, compact);
  if (replay) return { record: replay, created: false };
  const verified = await verifyAttestation(sql, compact, now);
  return sql.begin(async (tx) => {
    // The registry chain's lock also serialises registry writes, so two
    // posts of one (iss, id) cannot both pass the duplicate check.
    const head = await lockAuditChain(tx, REGISTRY_AUDIT_CHAIN);
    const existing = await tx`
      SELECT * FROM registry_attestations
      WHERE issuer_entity_id = ${verified.claims.iss} AND attestation_id = ${verified.claims.id}`;
    if (existing[0]) {
      const record = toRecord(existing[0] as Record<string, unknown>);
      if (record.jws === verified.compact) return { record, created: false };
      throw new AttestationError('attestation_conflict', 'id_reused',
        'the issuer already registered a different attestation with this id');
    }
    // The key may have changed since it was read outside the transaction.
    if (verified.subject.kind === 'agent') {
      await checkAttestedKey(tx, verified.subject.agentId!, verified.claims.keyThumbprint!, now, true);
    }
    const record = await insertRecord(tx, verified, null, now);
    await appendPlatformAuditEntries(tx, REGISTRY_AUDIT_CHAIN, head, [{
      action: 'grantex.registry.attestation_accepted',
      metadata: auditMetadata(record, `issuer:${record.issuerEntityId}`),
    }]);
    await recompute(tx, record, now);
    return { record, created: true };
  }) as Promise<{ record: AttestationRecord; created: boolean }>;
}

interface Authenticated {
  requestedBy: string;
  nonce: { iss: string; nonce: string; expiresAt: Date } | null;
  request: { iss: string; id: string } | null;
}

async function authenticate(sql: Sql, actor: RegistryActor, action: AttestationRequestAction, now: Date): Promise<Authenticated> {
  if (actor.kind === 'operator') return { requestedBy: actor.requestedBy, nonce: null, request: null };
  const verified = await verifyAttestationRequest(actor.request, {
    action,
    audience: config.jwtIssuer,
    now,
    // Suspension does not stop an issuer withdrawing its own attestation;
    // a withdrawn issuer, or a revoked kid, has no key and cannot.
    resolveKey: (iss, kid) => issuerVerificationKey(sql, iss, kid),
    eddsaEnabled: config.registryAttestationEddsaEnabled,
  });
  return {
    requestedBy: `issuer:${verified.iss}`,
    nonce: {
      iss: verified.iss,
      nonce: verified.nonce,
      expiresAt: new Date((verified.iat + REQUEST_MAX_AGE_SECONDS + CLOCK_SKEW_SECONDS) * 1000),
    },
    request: { iss: verified.iss, id: verified.id },
  };
}

function requireRecord(record: AttestationRecord | null): AttestationRecord {
  if (!record) throw new AttestationError('attestation_not_registered', 'unknown_attestation', 'the registry has no such attestation');
  return record;
}

function checkRequestNamesRecord(auth: Authenticated, record: AttestationRecord): void {
  if (auth.request && (auth.request.iss !== record.issuerEntityId || auth.request.id !== record.attestationId)) {
    throw new AttestationError('attestation_mismatch', 'request_for_other_attestation',
      'the signed request names another attestation or another issuer');
  }
}

/** Record a request nonce, refusing one already used. Old nonces are pruned in passing. */
async function consumeNonce(tx: TxSql, auth: Authenticated): Promise<void> {
  if (!auth.nonce) return;
  await tx`
    DELETE FROM registry_attestation_request_nonces
    WHERE ctid IN (SELECT ctid FROM registry_attestation_request_nonces WHERE expires_at < NOW() LIMIT 100)`;
  const inserted = await tx`
    INSERT INTO registry_attestation_request_nonces (issuer_entity_id, nonce, expires_at)
    VALUES (${auth.nonce.iss}, ${auth.nonce.nonce}, ${auth.nonce.expiresAt})
    ON CONFLICT (issuer_entity_id, nonce) DO NOTHING
    RETURNING nonce`;
  if (inserted.length === 0) {
    throw new AttestationError('request_signature_invalid', 'replay', 'this signed request has already been used');
  }
}

/**
 * Withdraw an attestation, on its issuer's signed request or the operator's
 * key: its record becomes `withdrawn` and its acceptance entry INVALID, which
 * is final. Withdrawing a withdrawn attestation answers the record again; a
 * superseded one is refused (its acceptance already ended with the refresh).
 */
export async function withdrawAttestation(
  sql: Sql,
  id: string,
  actor: RegistryActor,
  now: Date = new Date(),
): Promise<AttestationRecord> {
  const auth = await authenticate(sql, actor, 'withdraw', now);
  checkRequestNamesRecord(auth, requireRecord(await getAttestation(sql, id)));
  return sql.begin(async (tx) => {
    const head = await lockAuditChain(tx, REGISTRY_AUDIT_CHAIN);
    await consumeNonce(tx, auth);
    const record = requireRecord(await selectRecord(tx, id, true));
    if (record.state === 'withdrawn') return record;
    if (record.state !== 'accepted') {
      throw new AttestationError('attestation_not_accepted', record.state, `the attestation is ${record.state}`);
    }
    await tx`
      UPDATE registry_attestations
      SET state = 'withdrawn', withdrawn_at = ${now}, updated_at = NOW()
      WHERE id = ${id}`;
    await setAcceptance(record.acceptanceListUri, record.acceptanceListIdx, 'invalid', tx);
    await appendPlatformAuditEntries(tx, REGISTRY_AUDIT_CHAIN, head, [{
      action: 'grantex.registry.attestation_withdrawn',
      metadata: auditMetadata(record, auth.requestedBy),
    }]);
    await recompute(tx, record, now);
    return requireRecord(await selectRecord(tx, id));
  }) as Promise<AttestationRecord>;
}

/**
 * Renew an attestation: a new JWS from the same issuer, for the same subject
 * and type, naming a new external credential. The new attestation is checked
 * like any posted one; the old record becomes `superseded` and its acceptance
 * entry INVALID, in the same transaction as the new record and its entry.
 */
export async function refreshAttestation(
  sql: Sql,
  id: string,
  compact: unknown,
  actor: RegistryActor,
  now: Date = new Date(),
): Promise<{ record: AttestationRecord; superseded: AttestationRecord }> {
  const auth = await authenticate(sql, actor, 'refresh', now);
  const current = requireRecord(await getAttestation(sql, id));
  checkRequestNamesRecord(auth, current);
  if (current.state !== 'accepted') {
    throw new AttestationError('attestation_not_accepted', current.state, `the attestation is ${current.state}`);
  }
  const verified = await verifyAttestation(sql, compact, now);
  const { claims } = verified;
  if (claims.iss !== current.issuerEntityId || claims.sub !== current.sub || claims.type !== current.type) {
    throw new AttestationError('attestation_mismatch', 'subject_or_type_changed',
      'a refresh keeps the issuer, the subject and the type of the attestation it renews');
  }
  if (claims.externalCredentialId === current.externalCredentialId) {
    throw new AttestationError('attestation_mismatch', 'same_external_credential',
      'a refresh names a new external_credential_id');
  }
  return sql.begin(async (tx) => {
    const head = await lockAuditChain(tx, REGISTRY_AUDIT_CHAIN);
    await consumeNonce(tx, auth);
    const old = requireRecord(await selectRecord(tx, id, true));
    if (old.state !== 'accepted') {
      throw new AttestationError('attestation_not_accepted', old.state, `the attestation is ${old.state}`);
    }
    const clash = await tx`
      SELECT 1 FROM registry_attestations
      WHERE issuer_entity_id = ${claims.iss} AND attestation_id = ${claims.id}`;
    if (clash.length > 0) {
      throw new AttestationError('attestation_conflict', 'id_reused', 'the issuer already registered an attestation with this id');
    }
    if (verified.subject.kind === 'agent') {
      await checkAttestedKey(tx, verified.subject.agentId!, claims.keyThumbprint!, now, true);
    }
    const record = await insertRecord(tx, verified, old.id, now);
    await tx`
      UPDATE registry_attestations
      SET state = 'superseded', superseded_by = ${record.id}, superseded_at = ${now}, updated_at = NOW()
      WHERE id = ${old.id}`;
    await setAcceptance(old.acceptanceListUri, old.acceptanceListIdx, 'invalid', tx);
    await appendPlatformAuditEntries(tx, REGISTRY_AUDIT_CHAIN, head, [
      { action: 'grantex.registry.attestation_superseded', metadata: { ...auditMetadata(old, auth.requestedBy), supersededBy: record.id } },
      { action: 'grantex.registry.attestation_accepted', metadata: { ...auditMetadata(record, auth.requestedBy), supersedes: old.id } },
    ]);
    await recompute(tx, record, now);
    return { record, superseded: requireRecord(await selectRecord(tx, old.id)) };
  }) as Promise<{ record: AttestationRecord; superseded: AttestationRecord }>;
}

/**
 * Read the issuer's status list for one attestation again and record what it
 * says in issuer_status (valid, revoked for INVALID or any other value, or
 * suspended) with until when the read stays fresh. A list that cannot be
 * read, verified or trusted records only the attempt (issuer_status_checked_at)
 * and throws: the recorded status is not overwritten by a guess, and its
 * freshness is not extended, so it stops counting once it runs out.
 */
export async function recheckIssuerStatus(sql: Sql, id: string, now: Date = new Date()): Promise<IssuerStatus> {
  const record = requireRecord(await getAttestation(sql, id));
  let read: { value: number; freshUntil: Date };
  try {
    const issuer = await getAccreditedIssuer(sql, record.issuerEntityId);
    if (!issuer) throw new AttestationError('issuer_not_accredited', 'issuer_not_accredited', 'the issuer is not in the registry');
    read = await readIssuerStatusList(sql, issuer, record.statusListUri, record.statusListIdx, now);
  } catch (err) {
    // Record the attempt so the worker moves on to other rows, then report
    // the failure: nothing about the status itself is written.
    await queries(sql)`UPDATE registry_attestations SET issuer_status_checked_at = ${now} WHERE id = ${id}`;
    throw err;
  }
  const status = issuerStatusOf(read.value);
  return sql.begin(async (tx) => {
    const head = await lockAuditChain(tx, REGISTRY_AUDIT_CHAIN);
    const current = requireRecord(await selectRecord(tx, id, true));
    await tx`
      UPDATE registry_attestations
      SET issuer_status = ${status}, issuer_status_checked_at = ${now},
          issuer_status_fresh_until = ${read.freshUntil}, updated_at = NOW()
      WHERE id = ${id}`;
    if (current.issuerStatus !== status) {
      await appendPlatformAuditEntries(tx, REGISTRY_AUDIT_CHAIN, head, [{
        action: 'grantex.registry.attestation_issuer_status_changed',
        metadata: { ...auditMetadata(current, 'registry'), from: current.issuerStatus, to: status },
      }]);
    }
    await recompute(tx, current, now);
    return status;
  }) as Promise<IssuerStatus>;
}
