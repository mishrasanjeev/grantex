// SPDX-License-Identifier: Apache-2.0
/**
 * Passport binding at grant issuance (PRD §8.4, §7 consent-time
 * presentation, §5 GrantPassportBinding; spec/passport-binding.md).
 *
 * With PASSPORT_BOUND_GRANTS_ENABLED=true, POST /v1/authorize takes an Agent
 * Passport (SD-JWT VC, spec/agent-passport-1.0.md) in `passport`. Before the
 * authorization request is written, the registry checks it, in this order,
 * stopping at the first refusal (PRD Appendix C codes):
 *
 *   1. the parameter is a non-empty string of at most MAX_PASSPORT_LENGTH
 *      characters (passport_malformed);
 *   2. its issuer is accredited for urn:grantex:tm:agent.identity and not
 *      suspended now (issuer_not_accredited, issuer_suspended,
 *      trust_mark_missing), asked before the signature so an unknown or
 *      suspended issuer is refused as such, as attestation ingestion does;
 *   3. it verifies with the issuer's key for its `kid`, from the registry's
 *      record only (issuerVerificationKey, owner decision 7), and is within
 *      its validity (passport_malformed, passport_not_accepted,
 *      passport_invalid_signature, passport_expired); it carries no KB-JWT;
 *   4. its `sub` is the requesting agent's DID (attestation_mismatch);
 *   5. its disclosed `attestation_id` names an agent.identity attestation the
 *      same issuer registered (attestation_not_registered), whose
 *      external_credential_hash is the passport's (attestation_hash_mismatch),
 *      which is still accepted (attestation_not_accepted) and not past its
 *      exp (passport_expired), for this agent and with the passport's own
 *      status entry (attestation_mismatch);
 *   6. both status sources: the registry's acceptance entry is VALID and the
 *      issuer's status for the attestation is valid and fresh, read again now
 *      when the registry's last read is stale (passport_revoked, status_stale);
 *   7. its cnf key is the attested key_thumbprint (key_binding_mismatch) and
 *      a usable key of the agent: active, or rotated within its overlap
 *      (key_unproven, key_not_active);
 *   8. the requested scopes are within the attestation's declared_limits, and
 *      a declared_limits the passport discloses is the attestation's
 *      (attestation_mismatch, with an audit entry on the developer's chain).
 *
 * The binding it returns is stored on the request, bound into the grant
 * token at the code exchange (after checking the registry's own records
 * again, recheckBindingAtIssuance) and recorded in grant_passport_bindings.
 * The grant never outlives the passport or its attestation: the exchange
 * ends it at the earlier of the two exp values when the requested lifetime
 * runs longer.
 * Every authority, status and verification path fails closed: a database or
 * network error propagates as an error, never as a pass.
 */
import type postgres from 'postgres';
import { config } from '../../config.js';
import { queries, type TxSql } from '../../db/client.js';
import { appendPlatformAuditEntries, lockAuditChain } from '../audit-chain.js';
import { acceptanceListIdFromUri } from './acceptance-status.js';
import { evaluateAgentKey, requiresP256, type AgentKeyStatus } from './agent-keys.js';
import { AttestationError, CLOCK_SKEW_SECONDS } from './attestation-jws.js';
import { recheckIssuerStatus } from './attestations.js';
import { isAccreditedFor, issuerVerificationKey } from './issuers.js';
import {
  PassportVerifyError,
  unverifiedPassportIssuer,
  verifyPassportPresentation,
  type VerifiedPassportPresentation,
} from './passport-verify.js';
import { TOKEN_STATUS } from './status-list-codec.js';
import { computeAgentTrust } from './trust-level.js';

type Sql = ReturnType<typeof postgres>;

/** The longest `passport` accepted, in characters: the same bound as an attestation JWS. */
export const MAX_PASSPORT_LENGTH = 16_384;
/** The RFC 9396 authorization_details type that carries the binding (owner decision 1). */
export const COMMERCE_DETAIL_TYPE = 'urn:grantex:commerce:v1';
/** The trust mark a passport's issuer must hold. */
export const AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
/** The audit action for a passport whose attestation does not cover the request. */
export const ATTESTATION_MISMATCH_AUDIT_ACTION = 'grantex.passport.attestation_mismatch';

export type PassportBindingCode =
  | 'passport_malformed'
  | 'passport_not_accepted'
  | 'passport_invalid_signature'
  | 'passport_expired'
  | 'passport_revoked'
  | 'issuer_not_accredited'
  | 'issuer_suspended'
  | 'trust_mark_missing'
  | 'attestation_not_registered'
  | 'attestation_hash_mismatch'
  | 'attestation_not_accepted'
  | 'attestation_mismatch'
  | 'key_binding_mismatch'
  | 'key_not_active'
  | 'key_unproven'
  | 'status_stale';

/**
 * HTTP status of each refusal. The API key authenticated the request, so a
 * refused passport is 403 (never 401); a passport that is not one is 400; a
 * status that cannot be established now is 503, as for attestations.
 */
export const PASSPORT_REFUSAL_STATUS: Record<PassportBindingCode, number> = {
  passport_malformed: 400,
  passport_not_accepted: 400,
  passport_invalid_signature: 403,
  passport_expired: 403,
  passport_revoked: 403,
  issuer_not_accredited: 403,
  issuer_suspended: 403,
  trust_mark_missing: 403,
  attestation_not_registered: 403,
  attestation_hash_mismatch: 403,
  attestation_not_accepted: 403,
  attestation_mismatch: 403,
  key_binding_mismatch: 403,
  key_not_active: 403,
  key_unproven: 403,
  status_stale: 503,
};

export class PassportBindingError extends Error {
  readonly code: PassportBindingCode;
  readonly reason: string;
  readonly statusCode: number;

  constructor(code: PassportBindingCode, reason: string, message: string) {
    super(message);
    this.name = 'PassportBindingError';
    this.code = code;
    this.reason = reason;
    this.statusCode = PASSPORT_REFUSAL_STATUS[code];
  }
}

function refuse(code: PassportBindingCode, reason: string, message: string): never {
  throw new PassportBindingError(code, reason, message);
}

/** What the consent step shows (PRD §7), snapshotted when the request is checked. */
export interface PassportConsentView {
  trust_level: string;
  verification_level: string;
  issuers: string[];
  declared_limits: Record<string, unknown> | null;
  software_name: string | null;
  software_version: string | null;
}

/** What a grant is bound to (PRD §5 GrantPassportBinding). Stored on the request as JSON. */
export interface PassportBinding {
  issuer: string;
  attestation_id: string;
  registry_attestation_id: string;
  external_credential_id: string;
  hash: string;
  key_thumbprint: string;
  acceptance: { uri: string; idx: number };
  /** The passport's exp, in seconds since the epoch. */
  passport_exp: number;
  consent: PassportConsentView;
}

export type GrantPassportBinding = Omit<PassportBinding, 'consent'>;

/** Step 1: the parameter's shape, before anything is read. */
export function checkPassportParameter(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    refuse('passport_malformed', 'not_sd_jwt', 'passport must be an Agent Passport SD-JWT, a non-empty string');
  }
  if (value.length > MAX_PASSPORT_LENGTH) {
    refuse('passport_malformed', 'too_large', `passport must be at most ${MAX_PASSPORT_LENGTH} characters`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function optionalDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

/** JSON with object members in sorted order, to compare two JSON values. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface AttestationRow {
  id: string;
  agentId: string | null;
  keyThumbprint: string | null;
  externalCredentialId: string;
  externalCredentialHash: string;
  level: string;
  declaredLimits: Record<string, unknown> | null;
  statusListUri: string;
  statusListIdx: number;
  acceptanceListUri: string;
  acceptanceListIdx: number;
  state: string;
  exp: Date;
  issuerStatus: string;
  issuerStatusFreshUntil: Date;
}

function toAttestationRow(row: Record<string, unknown>): AttestationRow {
  const limits = typeof row['declared_limits'] === 'string'
    ? JSON.parse(row['declared_limits']) as Record<string, unknown>
    : (row['declared_limits'] as Record<string, unknown> | null) ?? null;
  return {
    id: row['id'] as string,
    agentId: (row['agent_id'] as string | null) ?? null,
    keyThumbprint: (row['key_thumbprint'] as string | null) ?? null,
    externalCredentialId: row['external_credential_id'] as string,
    externalCredentialHash: row['external_credential_hash'] as string,
    level: row['level'] as string,
    declaredLimits: limits,
    statusListUri: row['status_list_uri'] as string,
    statusListIdx: Number(row['status_list_idx']),
    acceptanceListUri: row['acceptance_list_uri'] as string,
    acceptanceListIdx: Number(row['acceptance_list_idx']),
    state: row['state'] as string,
    exp: toDate(row['exp']),
    issuerStatus: row['issuer_status'] as string,
    issuerStatusFreshUntil: toDate(row['issuer_status_fresh_until']),
  };
}

async function selectAttestation(q: TxSql, where: { id: string } | { issuer: string; attestationId: string }): Promise<AttestationRow | null> {
  const rows = 'id' in where
    ? await q`SELECT * FROM registry_attestations WHERE id = ${where.id}`
    : await q`SELECT * FROM registry_attestations
              WHERE issuer_entity_id = ${where.issuer} AND attestation_id = ${where.attestationId}
                AND type = ${AGENT_IDENTITY}`;
  return rows[0] ? toAttestationRow(rows[0] as Record<string, unknown>) : null;
}

async function checkAccredited(sql: Sql, issuer: string, now: Date): Promise<void> {
  const accreditation = await isAccreditedFor(sql, issuer, AGENT_IDENTITY, now);
  if (!accreditation.accredited) {
    refuse(accreditation.code, accreditation.code, `the issuer is not accredited for ${AGENT_IDENTITY} now`);
  }
}

/** The registry's acceptance entry (migration 123): VALID, or the refusal. */
async function checkAcceptance(q: TxSql, uri: string, idx: number): Promise<void> {
  const listId = acceptanceListIdFromUri(uri);
  // A URI that is not one of this registry's lists has no entry the registry can answer for.
  if (listId === null) refuse('attestation_not_registered', 'acceptance_entry_missing', 'the attestation has no acceptance entry here');
  const rows = await q`SELECT status FROM registry_acceptance_entries WHERE list_id = ${listId} AND idx = ${idx}`;
  if (!rows[0]) refuse('attestation_not_registered', 'acceptance_entry_missing', 'the attestation has no acceptance entry here');
  const status = Number(rows[0]['status']);
  if (status === TOKEN_STATUS.VALID) return;
  if (status === TOKEN_STATUS.SUSPENDED) {
    refuse('passport_revoked', 'acceptance_suspended', 'the registry has suspended its acceptance of this attestation');
  }
  // INVALID, and any value this code does not know: fail closed.
  refuse('passport_revoked', 'acceptance_invalid', 'the registry no longer accepts this attestation');
}

/** The attestation's exp: at or before now, it no longer vouches for the passport. */
function refuseIfAttestationExpired(record: AttestationRow, now: Date): void {
  if (record.exp.getTime() <= now.getTime()) {
    refuse('passport_expired', 'attestation_expired', 'the passport\'s attestation has expired');
  }
}

/**
 * Read the issuer's status list for an attestation now and record the read
 * (recheckIssuerStatus). Every way of failing to read it is a refusal
 * (status_stale, or the code it names); anything else propagates.
 */
async function readIssuerStatusNow(sql: Sql, registryAttestationId: string, now: Date): Promise<string> {
  try {
    return await recheckIssuerStatus(sql, registryAttestationId, now);
  } catch (err) {
    if (err instanceof AttestationError) refuse(err.code as PassportBindingCode, err.reason, err.message);
    throw err;
  }
}

function refuseUnlessValid(issuerStatus: string): void {
  if (issuerStatus === 'valid') return;
  if (issuerStatus === 'suspended') refuse('passport_revoked', 'suspended', 'the issuer has suspended this passport');
  // revoked, and anything unknown: fail closed.
  refuse('passport_revoked', 'invalid', 'the issuer has revoked this passport');
}

async function checkAgentKey(q: TxSql, agentId: string, thumbprint: string, now: Date): Promise<void> {
  const rows = await q`
    SELECT status, valid_from, valid_to, possession_proved_at FROM agent_keys
    WHERE thumbprint = ${thumbprint} AND agent_id = ${agentId}`;
  const row = rows[0];
  // Not in this agent's history reads exactly like never proven: the answer
  // does not say whether another agent holds the key.
  if (!row) refuse('key_unproven', 'key_unproven', 'the passport key is not a proven key of this agent');
  const result = evaluateAgentKey({
    status: row['status'] as AgentKeyStatus,
    validFrom: toDate(row['valid_from']),
    validTo: optionalDate(row['valid_to']),
    possessionProvedAt: optionalDate(row['possession_proved_at']),
  }, now);
  if (!result.usable) {
    refuse(result.denial, result.denial, result.denial === 'key_unproven'
      ? 'the passport key is not a proven key of this agent'
      : 'the passport key is compromised, or rotated out past its overlap');
  }
}

/**
 * The scopes of a request that its attestation's declared_limits do not
 * cover (spec/passport-binding.md §4, step 8). The registry reads one member:
 * `scopes`, when present, lists the scopes the issuer checked the agent
 * declares, and every requested scope must be in it. Other members (amounts,
 * currencies) have no counterpart in an authorization request; they are
 * shown at consent and bound to the grant through its attestation.
 */
function scopesNotDeclared(declared: Record<string, unknown> | null, scopes: readonly string[]): string[] | 'unreadable' {
  if (declared === null || !Object.hasOwn(declared, 'scopes')) return [];
  const listed = declared['scopes'];
  if (!Array.isArray(listed) || listed.some((scope) => typeof scope !== 'string')) return 'unreadable';
  return scopes.filter((scope) => !(listed as string[]).includes(scope));
}

interface MismatchAudit {
  developerId: string;
  agentId: string;
  agentDid: string;
  reason: string;
  issuerEntityId: string;
  attestationId: string | null;
  registryAttestationId: string | null;
  scopesNotDeclared?: string[];
}

/**
 * The audit entry for an attestation_mismatch, on the developer's own chain
 * (issuer telemetry is Phase 2), then the refusal. The entry is written in a
 * transaction of its own: the request is refused whether or not it commits,
 * and a failure to write it propagates as an error rather than a pass.
 */
async function mismatch(sql: Sql, audit: MismatchAudit, message: string): Promise<never> {
  await sql.begin(async (raw) => {
    const tx = raw as unknown as TxSql;
    const head = await lockAuditChain(tx, audit.developerId);
    await appendPlatformAuditEntries(tx, audit.developerId, head, [{
      action: ATTESTATION_MISMATCH_AUDIT_ACTION,
      agentId: audit.agentId,
      agentDid: audit.agentDid,
      metadata: {
        reason: audit.reason,
        issuerEntityId: audit.issuerEntityId,
        attestationId: audit.attestationId,
        registryAttestationId: audit.registryAttestationId,
        ...(audit.scopesNotDeclared !== undefined ? { scopesNotDeclared: audit.scopesNotDeclared } : {}),
      },
    }]);
  });
  refuse('attestation_mismatch', audit.reason, message);
}

async function verify(sql: Sql, compact: string, declaredRails: readonly string[], now: Date): Promise<VerifiedPassportPresentation> {
  try {
    return await verifyPassportPresentation({
      compact,
      // Owner decision 7: the key comes only from the registry's record for
      // this issuer and kid. The registry records keys by kid, so a passport
      // without one has no key (issuer_key_not_found).
      issuerKeys: async (iss, kid) => {
        if (kid === undefined) return [];
        const key = await issuerVerificationKey(sql, iss, kid);
        return key === null ? [] : [key];
      },
      now: Math.floor(now.getTime() / 1000),
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
      allowEdDSA: config.registryAttestationEddsaEnabled,
      paymentsRails: requiresP256(declaredRails),
    });
  } catch (err) {
    // A refusal of the passport becomes the route's refusal; anything else
    // (the registry could not be read) propagates: never a pass.
    if (err instanceof PassportVerifyError) refuse(err.code, err.reason, err.message);
    throw err;
  }
}

export interface PassportRequest {
  passport: string;
  developerId: string;
  agentId: string;
  scopes: readonly string[];
  now?: Date;
}

/**
 * Steps 2 to 8 of the module comment for a passport presented at
 * POST /v1/authorize. Returns the binding, or throws PassportBindingError.
 */
export async function evaluatePassportForAuthorization(sql: Sql, request: PassportRequest): Promise<PassportBinding> {
  const q = queries(sql);
  const now = request.now ?? new Date();
  const agents = await q`
    SELECT did, declared_rails FROM agents
    WHERE id = ${request.agentId} AND developer_id = ${request.developerId}`;
  // The route found the agent a moment ago; one that vanished since is refused.
  if (!agents[0]) refuse('attestation_mismatch', 'subject_mismatch', 'the agent is not registered');
  const agentDid = agents[0]['did'] as string;
  const declaredRails = Array.isArray(agents[0]['declared_rails']) ? agents[0]['declared_rails'] as string[] : [];

  // Step 2. Nothing read here is trusted; it only picks the issuer to ask about.
  const claimedIssuer = unverifiedPassportIssuer(request.passport);
  if (claimedIssuer !== null) await checkAccredited(sql, claimedIssuer, now);

  // Step 3. The signature covers iss, so a verified passport's issuer is the
  // one just asked about; verification refuses one whose iss was unreadable.
  const passport = await verify(sql, request.passport, declaredRails, now);

  const audit = (reason: string, record: AttestationRow | null, extra: Partial<MismatchAudit> = {}): MismatchAudit => ({
    developerId: request.developerId,
    agentId: request.agentId,
    agentDid,
    reason,
    issuerEntityId: passport.iss,
    attestationId: passport.disclosed.attestation_id ?? null,
    registryAttestationId: record?.id ?? null,
    ...extra,
  });

  // Step 4.
  if (passport.sub !== agentDid) {
    await mismatch(sql, audit('subject_mismatch', null), 'the passport is not this agent\'s');
  }

  // Step 5.
  const attestationId = passport.disclosed.attestation_id;
  if (attestationId === undefined) {
    refuse('attestation_not_registered', 'attestation_id_missing', 'the passport does not disclose its attestation_id');
  }
  const record = await selectAttestation(q, { issuer: passport.iss, attestationId });
  if (!record) {
    refuse('attestation_not_registered', 'attestation_not_registered', 'the issuer has not registered this passport\'s attestation');
  }
  if (record.externalCredentialHash !== passport.externalCredentialHash) {
    refuse('attestation_hash_mismatch', 'attestation_hash_mismatch', 'the passport is not the one its attestation registered');
  }
  if (record.state !== 'accepted') {
    refuse('attestation_not_accepted', record.state, `the attestation is ${record.state}`);
  }
  // Attestations never move to an expired state: their exp is read here.
  refuseIfAttestationExpired(record, now);
  if (record.agentId !== request.agentId) {
    await mismatch(sql, audit('subject_mismatch', record), 'the attestation is for another agent');
  }
  if (passport.status.status_list.uri !== record.statusListUri || passport.status.status_list.idx !== record.statusListIdx) {
    await mismatch(sql, audit('status_reference_mismatch', record),
      'the passport\'s status entry is not the one its attestation registered');
  }

  // Step 6: the registry's own acceptance, then the issuer's status.
  await checkAcceptance(q, record.acceptanceListUri, record.acceptanceListIdx);
  let issuerStatus = record.issuerStatus;
  if (record.issuerStatusFreshUntil.getTime() <= now.getTime()) {
    // The recorded read no longer counts: read the issuer's list now, as the
    // recheck worker would.
    issuerStatus = await readIssuerStatusNow(sql, record.id, now);
  }
  refuseUnlessValid(issuerStatus);

  // Step 7.
  if (passport.cnfThumbprint !== record.keyThumbprint) {
    refuse('key_binding_mismatch', 'key_binding_mismatch', 'the passport binds a key other than the attested key');
  }
  await checkAgentKey(q, request.agentId, passport.cnfThumbprint, now);

  // Step 8.
  const outside = scopesNotDeclared(record.declaredLimits, request.scopes);
  if (outside === 'unreadable') {
    await mismatch(sql, audit('declared_limits_unreadable', record), 'the attestation\'s declared_limits.scopes is not a list of scopes');
  } else if (outside.length > 0) {
    await mismatch(sql, audit('scope_not_declared', record, { scopesNotDeclared: outside }),
      'a requested scope is outside the attestation\'s declared limits');
  }
  const disclosedLimits = passport.disclosed.agent?.['declared_limits'];
  if (disclosedLimits !== undefined && canonicalJson(disclosedLimits) !== canonicalJson(record.declaredLimits ?? {})) {
    await mismatch(sql, audit('declared_limits_differ', record), 'the passport declares other limits than its attestation');
  }

  const trust = await computeAgentTrust(sql, agentDid, now);
  const agentClaim = passport.disclosed.agent;
  return {
    issuer: passport.iss,
    attestation_id: attestationId,
    registry_attestation_id: record.id,
    external_credential_id: record.externalCredentialId,
    hash: passport.externalCredentialHash,
    key_thumbprint: passport.cnfThumbprint,
    acceptance: { uri: record.acceptanceListUri, idx: record.acceptanceListIdx },
    passport_exp: passport.exp,
    consent: {
      trust_level: trust?.level ?? 'basic',
      verification_level: record.level,
      issuers: [...new Set([passport.iss, ...(trust?.issuers ?? [])])].sort(),
      declared_limits: record.declaredLimits,
      software_name: typeof agentClaim?.['software_name'] === 'string' ? agentClaim['software_name'] : null,
      software_version: typeof agentClaim?.['software_version'] === 'string' ? agentClaim['software_version'] : null,
    },
  };
}

const BINDING_STRINGS = ['issuer', 'attestation_id', 'registry_attestation_id', 'external_credential_id', 'hash', 'key_thumbprint'] as const;

/**
 * The grant binding in a stored value (auth_requests.passport_binding, or a
 * grant_passport_bindings row rebuilt by the refresh). Anything without the
 * shape the registry wrote is corrupt and throws: the caller refuses to issue
 * rather than issue an unbound grant.
 */
export function parseStoredBinding(value: unknown): GrantPassportBinding {
  const stored = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!isObject(stored) || !isObject(stored['acceptance'])) throw new Error('stored passport binding is not an object');
  for (const name of BINDING_STRINGS) {
    if (typeof stored[name] !== 'string' || (stored[name] as string).length === 0) {
      throw new Error(`stored passport binding has no ${name}`);
    }
  }
  const acceptance = stored['acceptance'];
  if (typeof acceptance['uri'] !== 'string' || !Number.isSafeInteger(acceptance['idx']) || (acceptance['idx'] as number) < 0) {
    throw new Error('stored passport binding has no acceptance entry');
  }
  if (!Number.isSafeInteger(stored['passport_exp']) || (stored['passport_exp'] as number) <= 0) {
    throw new Error('stored passport binding has no passport_exp');
  }
  const binding = {} as Record<string, unknown>;
  for (const name of BINDING_STRINGS) binding[name] = stored[name];
  binding['acceptance'] = { uri: acceptance['uri'], idx: acceptance['idx'] };
  binding['passport_exp'] = stored['passport_exp'];
  return binding as unknown as GrantPassportBinding;
}

/** The binding recorded for a grant, from the refresh's join on grant_passport_bindings; null when unbound. */
export function bindingFromGrantRow(row: Record<string, unknown>): GrantPassportBinding | null {
  if (row['passport_issuer_entity_id'] === null || row['passport_issuer_entity_id'] === undefined) return null;
  return parseStoredBinding({
    issuer: row['passport_issuer_entity_id'],
    attestation_id: row['passport_attestation_id'],
    registry_attestation_id: row['passport_registry_attestation_id'],
    external_credential_id: row['passport_external_credential_id'],
    hash: row['passport_hash'],
    key_thumbprint: row['passport_key_thumbprint'],
    acceptance: { uri: row['passport_acceptance_list_uri'], idx: Number(row['passport_acceptance_list_idx']) },
    passport_exp: row['passport_expires_at'] === null || row['passport_expires_at'] === undefined
      ? null
      : Math.floor(toDate(row['passport_expires_at']).getTime() / 1000),
  });
}

/** The authorization_details entry that carries the binding (owner decision 1). */
export function commerceAuthorizationDetail(binding: GrantPassportBinding): Record<string, unknown> {
  return {
    type: COMMERCE_DETAIL_TYPE,
    passport: {
      issuer: binding.issuer,
      id: binding.attestation_id,
      hash: binding.hash,
      key_thumbprint: binding.key_thumbprint,
    },
    acceptance_status: { uri: binding.acceptance.uri, idx: binding.acceptance.idx },
  };
}

/**
 * The recorded issuer status of a bound grant's attestation is past its
 * freshness. Thrown by recheckBindingAtIssuance when the caller may read the
 * issuer's list again: the caller leaves its issuing transaction (no network
 * inside it), calls refreshBoundIssuerStatus and checks again, once.
 */
export class BoundIssuerStatusStale extends Error {
  readonly registryAttestationId: string;

  constructor(registryAttestationId: string) {
    super('the recorded issuer status of the bound attestation is stale');
    this.name = 'BoundIssuerStatusStale';
    this.registryAttestationId = registryAttestationId;
  }
}

/**
 * Read the issuer's status list for a bound attestation now, outside any
 * issuing transaction, and record the read. Throws PassportBindingError
 * (status_stale, or the code it names) when the list cannot be read.
 */
export async function refreshBoundIssuerStatus(sql: Sql, registryAttestationId: string, now: Date): Promise<void> {
  await readIssuerStatusNow(sql, registryAttestationId, now);
}

export interface IssuanceRecheck {
  /** The instant the issuance is checked at: the request's start. */
  now: Date;
  /**
   * When the recorded issuer status is stale: true throws
   * BoundIssuerStatusStale so the caller reads the list again; false refuses
   * with status_stale.
   */
  rereadAllowed: boolean;
}

/**
 * The registry's own records, checked again when a bound grant's token is
 * issued (code exchange) or refreshed: the issuer is still accredited and not
 * suspended; the attestation still accepted, unchanged and not past its exp;
 * the passport not past its exp; the attestation's acceptance entry VALID;
 * the issuer's recorded status valid and fresh (both status sources, as at
 * authorization); and the key still usable by the agent. No network inside
 * the issuing transaction: a stale recorded status is either read again by
 * the caller outside it (BoundIssuerStatusStale) or refused. Returns the
 * latest instant the grant may run to: the earlier of the passport's and the
 * attestation's exp. Throws PassportBindingError.
 */
export async function recheckBindingAtIssuance(
  sql: Sql,
  tx: TxSql,
  binding: GrantPassportBinding,
  agentId: string,
  options: IssuanceRecheck,
): Promise<{ notAfter: Date }> {
  const { now } = options;
  await checkAccredited(sql, binding.issuer, now);
  const record = await selectAttestation(tx, { id: binding.registry_attestation_id });
  if (!record) refuse('attestation_not_registered', 'attestation_not_registered', 'the bound attestation is no longer registered');
  if (record.state !== 'accepted') refuse('attestation_not_accepted', record.state, `the attestation is ${record.state}`);
  if (record.agentId !== agentId || record.keyThumbprint !== binding.key_thumbprint
      || record.externalCredentialHash !== binding.hash) {
    refuse('attestation_mismatch', 'binding_changed', 'the bound attestation no longer matches the binding');
  }
  const passportExp = new Date(binding.passport_exp * 1000);
  if (passportExp.getTime() <= now.getTime()) refuse('passport_expired', 'expired', 'the passport has expired');
  refuseIfAttestationExpired(record, now);
  await checkAcceptance(tx, binding.acceptance.uri, binding.acceptance.idx);
  if (record.issuerStatusFreshUntil.getTime() <= now.getTime()) {
    // A recorded read past its freshness is not relied on: the issuer may have
    // revoked since on a list the registry has not read (trust-level.ts does
    // the same). Fail closed unless the caller may read it again.
    if (options.rereadAllowed) throw new BoundIssuerStatusStale(record.id);
    refuse('status_stale', 'issuer_status_stale', 'the issuer\'s status for the passport cannot be established now');
  }
  refuseUnlessValid(record.issuerStatus);
  await checkAgentKey(tx, agentId, binding.key_thumbprint, now);
  return { notAfter: new Date(Math.min(passportExp.getTime(), record.exp.getTime())) };
}

/** Record a bound grant (migration 125), in the transaction that writes the grant. */
export async function insertGrantBinding(
  tx: TxSql,
  grant: { grantId: string; developerId: string; agentId: string },
  binding: GrantPassportBinding,
): Promise<void> {
  await tx`
    INSERT INTO grant_passport_bindings (
      grant_id, developer_id, agent_id, issuer_entity_id, attestation_id, registry_attestation_id,
      external_credential_id, passport_hash, key_thumbprint, acceptance_list_uri, acceptance_list_idx,
      passport_expires_at
    ) VALUES (
      ${grant.grantId}, ${grant.developerId}, ${grant.agentId}, ${binding.issuer}, ${binding.attestation_id},
      ${binding.registry_attestation_id}, ${binding.external_credential_id}, ${binding.hash},
      ${binding.key_thumbprint}, ${binding.acceptance.uri}, ${binding.acceptance.idx},
      ${new Date(binding.passport_exp * 1000)}
    )`;
}

/**
 * The consent view of a stored binding, camelCase as the rest of
 * /v1/consent, or null when the request carries no passport.
 */
export function consentViewOf(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const stored = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  const view = isObject(stored) && isObject(stored['consent']) ? stored['consent'] : null;
  if (view === null) throw new Error('stored passport binding has no consent view');
  return {
    trustLevel: view['trust_level'],
    verificationLevel: view['verification_level'],
    issuers: view['issuers'],
    declaredLimits: view['declared_limits'],
    softwareName: view['software_name'],
    softwareVersion: view['software_version'],
  };
}
