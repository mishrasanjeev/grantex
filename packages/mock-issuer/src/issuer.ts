// SPDX-License-Identifier: Apache-2.0
//
// The mock accredited issuer: https://mock-issuer.example with a static
// JWKS (Phase 1, owner decision 7; Entity Configuration through OpenID
// Federation is Phase 2), Agent Passport issuance after a possession proof,
// its own passport status lists, and attestations (PRD Appendix A) for the
// registry. Everything runs in process with no network; startMockIssuerServer
// (server.ts) serves the JWKS and the lists on 127.0.0.1.

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_PASSPORT_LIFETIME_SECONDS,
  externalCredentialHash,
  issuePassport as issueSdJwtVc,
  jwkThumbprint,
  type AgentClaim,
  type Jwk,
  type ProviderClaim,
  type StatusReference,
  type VerificationClaim,
} from '@grantex/agent-passport';
import { signJws } from './jose.ts';
import { MockIssuerError } from './errors.ts';
import { newAttestationId, newPassportId } from './ids.ts';
import { generateIssuerKey, loadOrCreateIssuerKey, type IssuerKey } from './keys.ts';
import { PossessionVerifier, checkAgentDid, checkAgentPublicKey, type PossessionChallenge } from './possession.ts';
import { TOKEN_STATUS, encodeBitstringStatusList, encodeTokenStatusList } from './status-list-codec.ts';
import { PassportStatusStore, type SerializedStatusList, type StatusSlot } from './status-store.ts';

/** The mock issuer's entity id (an OpenID Federation Entity Identifier, bare origin). */
export const MOCK_ISSUER_ENTITY_ID = 'https://mock-issuer.example';
/** Its status_list_base: every passport status list sits under it. */
export const MOCK_ISSUER_STATUS_LIST_BASE = `${MOCK_ISSUER_ENTITY_ID}/status/`;
/** Owner decision 5: status list ttl for the mock issuer and CI. */
export const CI_STATUS_TTL_SECONDS = 1;
/** Owner decision 5: status list ttl otherwise. */
export const STANDARD_STATUS_TTL_SECONDS = 600;
/** exp - iat of every signed status list; a relying party refetches after ttl. */
export const STATUS_LIST_LIFETIME_SECONDS = 3600;
/** Passport lifetime when the caller gives none. */
export const DEFAULT_PASSPORT_LIFETIME_SECONDS = 30 * 86_400;
/** PRD Appendix A: the attestation's explicit type (RFC 8725 section 3.11). */
export const ATTESTATION_TYP = 'grantex-attestation+jwt';
/** The trust mark types the mock attests (docs/issuers/becoming-an-accredited-issuer.md). */
export const TRUST_MARK_AGENT_IDENTITY = 'urn:grantex:tm:agent.identity';
export const TRUST_MARK_PROVIDER_ENTITY = 'urn:grantex:tm:provider.entity';
export type MockAttestationType = typeof TRUST_MARK_AGENT_IDENTITY | typeof TRUST_MARK_PROVIDER_ENTITY;

export const STATE_FILE = 'state.json';
const STATE_VERSION = 1;

/** draft-ietf-oauth-status-list-21 section 4.1: two bits carry VALID, INVALID and SUSPENDED. */
const TSL_BITS = 2;

export type PassportStatus = 'valid' | 'invalid' | 'suspended';
export type BitstringStatusPurpose = 'revocation' | 'suspension';

const STATUS_NAME: Record<number, PassportStatus> = {
  [TOKEN_STATUS.VALID]: 'valid',
  [TOKEN_STATUS.INVALID]: 'invalid',
  [TOKEN_STATUS.SUSPENDED]: 'suspended',
};

export interface MockIssuerOptions {
  /** Keep the key and the state here (created if missing). Without it, everything is in memory. */
  dir?: string;
  /** Status list ttl in seconds; overrides ttlProfile. */
  ttlSeconds?: number;
  /** 'ci' (1 s, the default) or 'standard' (600 s), owner decision 5. */
  ttlProfile?: 'ci' | 'standard';
  /** Seconds since the epoch; defaults to the system clock. For tests. */
  clock?: () => number;
}

export interface IssuePassportRequest {
  agentDid: string;
  agentPublicJwk: Jwk;
  /** The agent's answer to createPossessionChallenge; issuance is refused without it. */
  possessionProof: string;
  provider: ProviderClaim;
  agent: AgentClaim;
  verification: VerificationClaim;
  lifetimeSeconds?: number;
}

export interface IssuedAgentPassport {
  /** att_<ulid>: the passport's attestation_id and the id of its agent.identity attestation. */
  attestationId: string;
  /** ppt_<ulid>: the attestation's external_credential_id. */
  passportId: string;
  /** The SD-JWT with every disclosure, ending with '~'. */
  compact: string;
  externalCredentialHash: string;
  keyThumbprint: string;
  status: StatusReference;
  iat: number;
  exp: number;
}

interface PassportRecord extends IssuedAgentPassport {
  kind: 'agent';
  agentDid: string;
  providerDid: string;
  level: string;
  declaredLimits: Record<string, unknown> | null;
  slot: StatusSlot;
  providerAttestationId: string | null;
}

interface ProviderAttestationRecord {
  kind: 'provider';
  attestationId: string;
  /** The passport this attestation was made from. */
  passportAttestationId: string;
  slot: StatusSlot;
}

type AttestationRecord = PassportRecord | ProviderAttestationRecord;

interface SerializedState {
  version: number;
  lists: SerializedStatusList[];
  records: AttestationRecord[];
}

function checkTtl(ttl: number): number {
  // draft-ietf-oauth-status-list-21 section 5.1: ttl is a positive number.
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new MockIssuerError('invalid_request', 'ttl must be a positive integer of seconds');
  return ttl;
}

export class MockIssuer {
  readonly entityId = MOCK_ISSUER_ENTITY_ID;
  readonly statusListBase = MOCK_ISSUER_STATUS_LIST_BASE;
  readonly ttlSeconds: number;
  readonly dir: string | undefined;
  readonly #key: IssuerKey;
  readonly #clock: () => number;
  readonly #possession: PossessionVerifier;
  #store = new PassportStatusStore();
  #records = new Map<string, AttestationRecord>();
  #stateText = '';

  private constructor(options: MockIssuerOptions) {
    this.dir = options.dir;
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.ttlSeconds = checkTtl(
      options.ttlSeconds ?? (options.ttlProfile === 'standard' ? STANDARD_STATUS_TTL_SECONDS : CI_STATUS_TTL_SECONDS),
    );
    this.#key = options.dir === undefined ? generateIssuerKey() : loadOrCreateIssuerKey(options.dir);
    this.#possession = new PossessionVerifier(this.entityId, this.#clock);
    this.refresh();
  }

  static create(options: MockIssuerOptions = {}): MockIssuer {
    return new MockIssuer(options);
  }

  get kid(): string {
    return this.#key.kid;
  }

  /** The static JWKS (RFC 7517 section 5): the public signing key only. */
  jwks(): { keys: Jwk[] } {
    return { keys: [{ ...this.#key.publicJwk }] };
  }

  // ── State ────────────────────────────────────────────────────────────────

  /**
   * Re-read the state directory if another process (the CLI) changed it.
   * A state file that cannot be read throws: serving an empty list in its
   * place would show revoked passports as valid.
   */
  refresh(): void {
    if (this.dir === undefined) return;
    const file = join(this.dir, STATE_FILE);
    // Compare contents: coarse filesystem timestamps can hide revocation writes.
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && this.#stateText === '') return;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MockIssuerError('state_unreadable', `${STATE_FILE} disappeared after being loaded`, { cause: error });
      }
      throw error;
    }
    let text: string;
    try {
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    if (text === this.#stateText) return;
    let state: SerializedState;
    try {
      state = JSON.parse(text) as SerializedState;
    } catch (cause) {
      throw new MockIssuerError('state_unreadable', `${STATE_FILE} is not JSON`, { cause });
    }
    if (state.version !== STATE_VERSION || !Array.isArray(state.lists) || !Array.isArray(state.records)) {
      throw new MockIssuerError('state_unreadable', `${STATE_FILE} is not a version ${STATE_VERSION} state file`);
    }
    this.#store = new PassportStatusStore({ lists: state.lists });
    this.#records = new Map(state.records.map((record) => [record.attestationId, record]));
    this.#stateText = text;
  }

  #save(): void {
    if (this.dir === undefined) return;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, STATE_FILE);
    const state: SerializedState = { version: STATE_VERSION, lists: this.#store.toJSON(), records: [...this.#records.values()] };
    const temp = `${file}.${process.pid}.tmp`;
    // Write then rename, so a reader never sees half a file.
    const text = `${JSON.stringify(state)}\n`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, file);
    this.#stateText = text;
  }

  #record(attestationId: string): AttestationRecord {
    const record = typeof attestationId === 'string' ? this.#records.get(attestationId) : undefined;
    if (record === undefined) {
      throw new MockIssuerError('attestation_not_registered', 'the mock issuer did not issue this attestation');
    }
    return record;
  }

  // ── Possession proof and issuance ────────────────────────────────────────

  /** Step one of issuance: a challenge the agent signs with the key to be bound. */
  createPossessionChallenge(params: { agentDid: string; agentPublicJwk: Jwk }): PossessionChallenge {
    return this.#possession.challenge(params.agentDid, params.agentPublicJwk);
  }

  /**
   * Issue an Agent Passport bound to `agentPublicJwk`, after checking the
   * agent's possession proof. The passport carries the provider, agent and
   * verification disclosures, a new attestation_id and a status reference
   * into the issuer's own list (draft-ietf-oauth-status-list-21 section 6.2).
   */
  issuePassport(request: IssuePassportRequest): IssuedAgentPassport {
    const agentDid = checkAgentDid(request.agentDid);
    const agentPublicJwk = checkAgentPublicKey(request.agentPublicJwk);
    // The proof comes first: nothing is allocated or signed for an unproven key.
    this.#possession.verify(request.possessionProof, agentDid, agentPublicJwk);
    const lifetime = request.lifetimeSeconds ?? DEFAULT_PASSPORT_LIFETIME_SECONDS;
    if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > MAX_PASSPORT_LIFETIME_SECONDS) {
      throw new MockIssuerError('invalid_request', 'lifetimeSeconds must be between 1 s and one year');
    }

    this.refresh();
    const slot = this.#store.allocate();
    const attestationId = newAttestationId();
    const passportId = newPassportId();
    try {
      const status: StatusReference = { status_list: { uri: this.statusListUri(slot.list), idx: slot.idx } };
      const iat = this.#clock();
      const exp = iat + lifetime;
      const { compact } = issueSdJwtVc({
        issuerKey: this.#key.privateJwk,
        iss: this.entityId,
        sub: agentDid,
        cnfJwk: agentPublicJwk,
        iat,
        exp,
        status,
        claims: {
          provider: request.provider,
          agent: request.agent,
          verification: request.verification,
          attestation_id: attestationId,
        },
      });
      const record: PassportRecord = {
        kind: 'agent',
        attestationId,
        passportId,
        compact,
        externalCredentialHash: externalCredentialHash(compact),
        keyThumbprint: jwkThumbprint(agentPublicJwk),
        status,
        iat,
        exp,
        agentDid,
        providerDid: request.provider.did,
        level: request.verification.level,
        declaredLimits: request.agent.declared_limits ?? null,
        slot,
        providerAttestationId: null,
      };
      this.#records.set(attestationId, record);
      this.#save();
      return this.#issued(record);
    } catch (error) {
      // Nothing was issued: forget the record, give the entry back, then report why.
      this.#records.delete(attestationId);
      this.#store.release(slot);
      throw error;
    }
  }

  #issued(record: PassportRecord): IssuedAgentPassport {
    const { attestationId, passportId, compact, externalCredentialHash: hash, keyThumbprint, status, iat, exp } = record;
    return { attestationId, passportId, compact, externalCredentialHash: hash, keyThumbprint, status, iat, exp };
  }

  /** A passport issued earlier, by its attestation id, or undefined. */
  passport(attestationId: string): IssuedAgentPassport | undefined {
    this.refresh();
    const record = this.#records.get(attestationId);
    return record?.kind === 'agent' ? this.#issued(record) : undefined;
  }

  // ── Attestations (PRD Appendix A) ────────────────────────────────────────

  /**
   * The attestation compact JWS for a passport: typ grantex-attestation+jwt,
   * ES256, kid. For agent.identity (the default) the id is the passport's
   * attestation_id and the status entry the passport's; sub is the agent DID
   * and key_thumbprint the RFC 7638 thumbprint of the bound key. For
   * provider.entity, sub is the provider DID, there is no key and no
   * declared_limits, and the attestation has an id and status entry of its
   * own, made once per passport. external_credential_hash follows the Agent
   * Passport hash rule (spec/agent-passport-1.0.md section 6).
   */
  buildAttestation(params: { attestationId: string; type?: MockAttestationType }): string {
    this.refresh();
    const type = params.type ?? TRUST_MARK_AGENT_IDENTITY;
    if (type !== TRUST_MARK_AGENT_IDENTITY && type !== TRUST_MARK_PROVIDER_ENTITY) {
      throw new MockIssuerError('invalid_request', `the mock issuer attests ${TRUST_MARK_AGENT_IDENTITY} and ${TRUST_MARK_PROVIDER_ENTITY} only`);
    }
    const record = this.#record(params.attestationId);
    if (record.kind !== 'agent') {
      throw new MockIssuerError('invalid_request', 'attest takes the attestation id of a passport');
    }
    this.#refuseUnlessValid(record.slot);
    const iat = this.#clock();
    const header = { alg: 'ES256', typ: ATTESTATION_TYP, kid: this.#key.kid };

    if (type === TRUST_MARK_AGENT_IDENTITY) {
      return signJws(header, {
        id: record.attestationId,
        iss: this.entityId,
        sub: record.agentDid,
        type,
        key_thumbprint: record.keyThumbprint,
        external_credential_id: record.passportId,
        external_credential_hash: record.externalCredentialHash,
        level: record.level,
        declared_limits: record.declaredLimits ?? {},
        iat,
        exp: record.exp,
        status: record.status,
      }, this.#key.privateJwk);
    }

    let provider = record.providerAttestationId === null ? undefined : this.#records.get(record.providerAttestationId);
    if (provider === undefined) {
      const slot = this.#store.allocate();
      provider = { kind: 'provider', attestationId: newAttestationId(), passportAttestationId: record.attestationId, slot };
      this.#records.set(provider.attestationId, provider);
      record.providerAttestationId = provider.attestationId;
      this.#save();
    }
    this.#refuseUnlessValid(provider.slot);
    return signJws(header, {
      id: provider.attestationId,
      iss: this.entityId,
      sub: record.providerDid,
      type,
      external_credential_id: record.passportId,
      external_credential_hash: record.externalCredentialHash,
      level: record.level,
      iat,
      exp: record.exp,
      status: { status_list: { uri: this.statusListUri(provider.slot.list), idx: provider.slot.idx } },
    }, this.#key.privateJwk);
  }

  #refuseUnlessValid(slot: StatusSlot): void {
    const status = this.#store.get(slot);
    if (status !== TOKEN_STATUS.VALID) {
      // An issuer does not attest a passport it has revoked or suspended.
      throw new MockIssuerError('passport_revoked', `the passport is ${STATUS_NAME[status]}`);
    }
  }

  // ── Revoke, suspend, reinstate ───────────────────────────────────────────

  passportStatus(attestationId: string): PassportStatus {
    this.refresh();
    return STATUS_NAME[this.#store.get(this.#record(attestationId).slot)]!;
  }

  /** INVALID, final (Bitstring Status List v1.0 section 2.1: revocation is not reversible). */
  revokePassport(attestationId: string): PassportStatus {
    return this.#transition(attestationId, TOKEN_STATUS.INVALID);
  }

  suspendPassport(attestationId: string): PassportStatus {
    return this.#transition(attestationId, TOKEN_STATUS.SUSPENDED);
  }

  reinstatePassport(attestationId: string): PassportStatus {
    return this.#transition(attestationId, TOKEN_STATUS.VALID);
  }

  /**
   * Flip an entry. A passport's provider.entity attestation names the
   * passport (external_credential_id and hash), so it follows the passport:
   * revoking or suspending the passport revokes or suspends it too, and
   * reinstating the passport reinstates it unless it was itself revoked.
   * A provider attestation can still be revoked or suspended on its own,
   * which leaves the passport as it is.
   */
  #transition(attestationId: string, next: number): PassportStatus {
    this.refresh();
    const record = this.#record(attestationId);
    const current = this.#store.get(record.slot);
    if (current === TOKEN_STATUS.INVALID && next !== TOKEN_STATUS.INVALID) {
      throw new MockIssuerError('passport_revoked', 'the passport was revoked; that is final');
    }
    let changed = false;
    if (current !== next) {
      this.#store.set(record.slot, next);
      changed = true;
    }
    const provider = record.kind === 'agent' && record.providerAttestationId !== null
      ? this.#records.get(record.providerAttestationId)
      : undefined;
    if (provider !== undefined) {
      const providerCurrent = this.#store.get(provider.slot);
      // Revocation is final for the provider attestation as well.
      if (providerCurrent !== next && providerCurrent !== TOKEN_STATUS.INVALID) {
        this.#store.set(provider.slot, next);
        changed = true;
      }
    }
    if (changed) this.#save();
    return STATUS_NAME[next]!;
  }

  // ── Published status lists ───────────────────────────────────────────────

  statusListUri(list: number): string {
    return `${this.statusListBase}${list}`;
  }

  statusListNumbers(): number[] {
    this.refresh();
    return this.#store.listNumbers();
  }

  hasStatusList(list: number): boolean {
    this.refresh();
    return this.#store.hasList(list);
  }

  /**
   * The Token Status List token (draft-ietf-oauth-status-list-21 section
   * 5.1): typ statuslist+jwt; sub the list URI, equal to the uri in each
   * passport (section 5.1); iat; exp; ttl in seconds; status_list with bits
   * 2 and lst (section 4.2). Signed with the issuer key, kid in the header.
   */
  tokenStatusList(list: number): string {
    this.refresh();
    const { capacity, entries } = this.#store.snapshot(list);
    const iat = this.#clock();
    return signJws(
      { alg: 'ES256', typ: 'statuslist+jwt', kid: this.#key.kid },
      {
        iss: this.entityId,
        sub: this.statusListUri(list),
        iat,
        exp: iat + STATUS_LIST_LIFETIME_SECONDS,
        ttl: this.ttlSeconds,
        status_list: { bits: TSL_BITS, lst: encodeTokenStatusList(entries, { bits: TSL_BITS, size: capacity }) },
      },
      this.#key.privateJwk,
    );
  }

  /**
   * A BitstringStatusListCredential (W3C Bitstring Status List v1.0 section
   * 2.2) for one purpose, secured as a VC-JWT (W3C VC-JOSE-COSE section
   * 3.1.1: the credential is the claims set, typ vc+jwt, cty vc, no vc
   * claim). revocation sets the bits of INVALID entries, suspension those of
   * SUSPENDED ones. ttl is in milliseconds (section 2.2).
   */
  bitstringStatusListCredential(list: number, purpose: BitstringStatusPurpose = 'revocation'): string {
    this.refresh();
    if (purpose !== 'revocation' && purpose !== 'suspension') {
      throw new MockIssuerError('invalid_request', `unknown statusPurpose ${String(purpose)}`);
    }
    const { capacity, entries } = this.#store.snapshot(list);
    const wanted = purpose === 'revocation' ? TOKEN_STATUS.INVALID : TOKEN_STATUS.SUSPENDED;
    const id = `${this.statusListUri(list)}/bitstring${purpose === 'revocation' ? '' : '/suspension'}`;
    const iat = this.#clock();
    const exp = iat + STATUS_LIST_LIFETIME_SECONDS;
    return signJws(
      { alg: 'ES256', typ: 'vc+jwt', cty: 'vc', kid: this.#key.kid },
      {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        id,
        type: ['VerifiableCredential', 'BitstringStatusListCredential'],
        issuer: this.entityId,
        validFrom: new Date(iat * 1000).toISOString(),
        validUntil: new Date(exp * 1000).toISOString(),
        credentialSubject: {
          id: `${id}#list`,
          type: 'BitstringStatusList',
          statusPurpose: purpose,
          encodedList: encodeBitstringStatusList(
            entries.filter((entry) => entry.status === wanted).map((entry) => entry.idx),
            capacity,
          ),
          ttl: this.ttlSeconds * 1000,
        },
        iat,
        exp,
      },
      this.#key.privateJwk,
    );
  }
}
