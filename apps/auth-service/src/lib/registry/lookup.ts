// SPDX-License-Identifier: Apache-2.0
/**
 * The registry lookup (PRD §7 Lookup): what a relying party reads about one
 * agent, by its DID, by the RFC 7638 thumbprint of a key in its history, or
 * by the credential an accredited issuer attested (issuer, external
 * credential id and hash, all three).
 *
 * Minimised by design. An unauthenticated relying party reads only:
 *
 *   agent_did, level, flags        computeAgentTrust, at call time
 *   issuers                        entity_ids of the counted attestations
 *   attestations                   type, issuer and expiry of each counted one
 *   keys                           thumbprint, status and whether it is current
 *   cimd_uri                       the agent's client metadata document
 *
 * and, for a thumbprint lookup, key_thumbprint, key_status and key_current
 * for the key asked about. A relying party authenticated with a developer API
 * key reads, in addition, the provider's DID, name and legal identifiers and,
 * for each counted attestation, its registry id, the issuer's status list
 * entry and the registry's acceptance entry. Nothing else leaves this module:
 * the response is built member by member, never by spreading a record.
 *
 * Fail closed: an agent the registry cannot resolve is null (the route's
 * 404), a credential that matches more than one agent is null too, and a
 * database error propagates.
 */
import type postgres from 'postgres';
import { queries, type TxSql } from '../../db/client.js';
import { evaluateAgentKey, type AgentKeyStatus } from './agent-keys.js';
import { computeAgentTrust, type TrustFlag, type TrustLevel } from './trust-level.js';

type Sql = ReturnType<typeof postgres>;

/** Lookups per client address per minute, whether authenticated or not. */
export const LOOKUP_RATE_LIMIT_PER_MINUTE = 120;
/**
 * max-age of a public answer: the short ttl of the registry's acceptance
 * lists during a cascade window, so a cached level is never older than a
 * relying party checking the lists could see.
 */
export const LOOKUP_PUBLIC_MAX_AGE_SECONDS = 60;

/** Every member an unauthenticated answer may carry; the thumbprint lookup adds the last three. */
export const PUBLIC_LOOKUP_MEMBERS = [
  'agent_did', 'level', 'flags', 'issuers', 'attestations', 'keys', 'cimd_uri',
  'key_thumbprint', 'key_status', 'key_current',
] as const;
/** What an authenticated relying party reads in addition: at the top level, and on each attestation. */
export const RELYING_PARTY_LOOKUP_MEMBERS = ['provider'] as const;
export const RELYING_PARTY_ATTESTATION_MEMBERS = ['id', 'issuer_status_list', 'acceptance_status_list'] as const;

const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
/** spec/attestation-1.0.md §3. */
const CREDENTIAL_HASH = /^sha-256:[A-Za-z0-9_-]{43}$/;
const MAX_DID_LENGTH = 2048;
const MAX_ISSUER_LENGTH = 2048;
const MAX_CREDENTIAL_ID_LENGTH = 256;

export class LookupRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookupRequestError';
  }
}

export type LookupRef =
  | { by: 'did'; did: string }
  | { by: 'key_thumbprint'; thumbprint: string }
  | { by: 'credential'; issuer: string; externalCredentialId: string; hash: string };

const CREDENTIAL_PARAMS = ['issuer', 'external_credential_id', 'hash'] as const;

function single(query: Record<string, unknown>, name: string): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new LookupRequestError(`${name} must be given once`);
  return value;
}

/**
 * The query of GET /v1/registry/agents: exactly one of key_thumbprint, or all
 * three of issuer, external_credential_id and hash. Anything else is refused
 * before the store is read, so a partial credential never narrows a search.
 */
export function parseLookupQuery(query: unknown): LookupRef {
  const params = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  for (const name of Object.keys(params)) {
    if (name !== 'key_thumbprint' && !(CREDENTIAL_PARAMS as readonly string[]).includes(name)) {
      throw new LookupRequestError(`${name} is not a lookup parameter`);
    }
  }
  const thumbprint = single(params, 'key_thumbprint');
  const credential = CREDENTIAL_PARAMS.map((name) => single(params, name));
  const given = credential.filter((value) => value !== undefined).length;

  if (thumbprint !== undefined) {
    if (given > 0) throw new LookupRequestError('look up by key_thumbprint or by credential, not both');
    if (!THUMBPRINT.test(thumbprint)) {
      throw new LookupRequestError('key_thumbprint must be a base64url SHA-256 JWK thumbprint (RFC 7638)');
    }
    return { by: 'key_thumbprint', thumbprint };
  }
  if (given !== CREDENTIAL_PARAMS.length) {
    throw new LookupRequestError('give key_thumbprint, or all of issuer, external_credential_id and hash');
  }
  const [issuer, externalCredentialId, hash] = credential as [string, string, string];
  if (issuer.length === 0 || issuer.length > MAX_ISSUER_LENGTH) throw new LookupRequestError('issuer must be an entity_id');
  if (externalCredentialId.length === 0 || externalCredentialId.length > MAX_CREDENTIAL_ID_LENGTH) {
    throw new LookupRequestError(`external_credential_id must be 1 to ${MAX_CREDENTIAL_ID_LENGTH} characters`);
  }
  if (!CREDENTIAL_HASH.test(hash)) throw new LookupRequestError('hash must be sha-256:<base64url SHA-256>');
  return { by: 'credential', issuer, externalCredentialId, hash };
}

/** A DID path segment; the route decodes it. */
export function parseLookupDid(did: unknown): LookupRef {
  if (typeof did !== 'string' || !did.startsWith('did:') || did.length > MAX_DID_LENGTH) {
    throw new LookupRequestError('the path must be an agent DID');
  }
  return { by: 'did', did };
}

export interface PublicAttestation {
  type: string;
  issuer: string;
  expires_at: string;
}

export interface RelyingPartyAttestation extends PublicAttestation {
  id: string;
  issuer_status_list: { uri: string; idx: number };
  acceptance_status_list: { uri: string; idx: number };
}

export interface LookupKey {
  thumbprint: string;
  status: AgentKeyStatus;
  /** Usable now: active, or rotated and still inside its overlap (evaluateAgentKey). */
  current: boolean;
}

export interface PublicAgentLookup {
  agent_did: string;
  level: TrustLevel;
  flags: TrustFlag[];
  issuers: string[];
  attestations: PublicAttestation[] | RelyingPartyAttestation[];
  keys: LookupKey[];
  cimd_uri: string | null;
  key_thumbprint?: string;
  key_status?: AgentKeyStatus;
  key_current?: boolean;
  provider?: { did: string; name: string | null; legal_identifiers: unknown[] } | null;
}

type Queryable = Sql | TxSql;

function handle(sql: Queryable): TxSql {
  return typeof (sql as Sql).begin === 'function' ? queries(sql as Sql) : sql as TxSql;
}

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function toKey(row: Record<string, unknown>, now: Date): LookupKey {
  const status = row['status'] as AgentKeyStatus;
  const evaluation = evaluateAgentKey({
    status,
    validFrom: new Date(row['valid_from'] as string),
    validTo: row['valid_to'] ? new Date(row['valid_to'] as string) : null,
    possessionProvedAt: row['possession_proved_at'] ? new Date(row['possession_proved_at'] as string) : null,
  }, now);
  return { thumbprint: row['thumbprint'] as string, status, current: evaluation.usable };
}

/**
 * The DID or thumbprint computeAgentTrust takes for a credential: the one
 * agent an attestation matching all three values names. No match, a match
 * on a provider attestation, or matches naming more than one agent are all
 * null, answered alike.
 */
async function agentForCredential(q: TxSql, ref: Extract<LookupRef, { by: 'credential' }>): Promise<string | null> {
  const rows = await q`
    SELECT DISTINCT a.did
    FROM registry_attestations r JOIN agents a ON a.id = r.agent_id
    WHERE r.issuer_entity_id = ${ref.issuer}
      AND r.external_credential_id = ${ref.externalCredentialId}
      AND r.external_credential_hash = ${ref.hash}
      AND r.subject_kind = 'agent'
    LIMIT 2`;
  return rows.length === 1 ? rows[0]!['did'] as string : null;
}

/**
 * Look one agent up. Null when there is no such agent: the caller answers
 * 404 and says nothing about why.
 */
export async function lookupAgent(
  sql: Queryable,
  ref: LookupRef,
  options: { authenticated: boolean; now?: Date },
): Promise<PublicAgentLookup | null> {
  const q = handle(sql);
  const now = options.now ?? new Date();
  let trustRef: string;
  if (ref.by === 'did') trustRef = ref.did;
  else if (ref.by === 'key_thumbprint') trustRef = ref.thumbprint;
  else {
    const did = await agentForCredential(q, ref);
    if (did === null) return null;
    trustRef = did;
  }

  const computed = await computeAgentTrust(q, trustRef, now);
  if (!computed) return null;

  const [agent] = await q`SELECT cimd_uri FROM agents WHERE id = ${computed.agent_id}`;
  const keyRows = await q`
    SELECT thumbprint, status, valid_from, valid_to, possession_proved_at
    FROM agent_keys WHERE agent_id = ${computed.agent_id}
    ORDER BY valid_from, thumbprint`;
  const keys = keyRows.map((row) => toKey(row as Record<string, unknown>, now));

  const attestationRows = computed.attestation_ids.length === 0 ? [] : await q`
    SELECT id, type, issuer_entity_id, exp, status_list_uri, status_list_idx, acceptance_list_uri, acceptance_list_idx
    FROM registry_attestations WHERE id = ANY(${computed.attestation_ids})
    ORDER BY type, issuer_entity_id, exp, id`;
  const attestations = attestationRows.map((row) => {
    const shown: PublicAttestation = {
      type: row['type'] as string,
      issuer: row['issuer_entity_id'] as string,
      expires_at: iso(row['exp']),
    };
    if (!options.authenticated) return shown;
    return {
      ...shown,
      id: row['id'] as string,
      issuer_status_list: { uri: row['status_list_uri'] as string, idx: Number(row['status_list_idx']) },
      acceptance_status_list: { uri: row['acceptance_list_uri'] as string, idx: Number(row['acceptance_list_idx']) },
    } satisfies RelyingPartyAttestation;
  });

  const result: PublicAgentLookup = {
    agent_did: computed.agent_did,
    level: computed.level,
    flags: computed.flags,
    issuers: computed.issuers,
    attestations,
    keys,
    cimd_uri: (agent?.['cimd_uri'] as string | null | undefined) ?? null,
  };

  if (ref.by === 'key_thumbprint') {
    const key = keys.find((candidate) => candidate.thumbprint === ref.thumbprint);
    // computeAgentTrust found the agent through this key, so it is in the
    // history; if it is not, something changed underneath: refuse.
    if (!key) return null;
    result.key_thumbprint = key.thumbprint;
    result.key_status = key.status;
    result.key_current = key.current;
  }

  if (options.authenticated) {
    let provider: PublicAgentLookup['provider'] = null;
    if (computed.provider_did !== null) {
      const [row] = await q`
        SELECT organization_did, name, legal_identifiers FROM trust_registry WHERE organization_did = ${computed.provider_did}`;
      if (row) {
        const identifiers = typeof row['legal_identifiers'] === 'string'
          ? JSON.parse(row['legal_identifiers'] as string) as unknown
          : row['legal_identifiers'];
        provider = {
          did: row['organization_did'] as string,
          name: (row['name'] as string | null) ?? null,
          legal_identifiers: Array.isArray(identifiers) ? identifiers : [],
        };
      }
    }
    result.provider = provider;
  }
  return result;
}
