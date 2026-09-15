/**
 * Privacy, hash-chain and cross-entry checks on a parsed evidence package.
 * Each check throws `VerificationFailure` at the first problem. The order of
 * checks is part of the specification and mirrors `grantex.evidence._checks`.
 */
import { IDENTIFIER_CLASSES, chainRoot, decisionActionHash, entryHash, headerHash, isActionReference, isPseudonym } from './hashing.js';
import { VerificationCode as Code, VerificationFailure, type VerificationCodeValue } from './result.js';
import { timestampMs } from './schema.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Tolerated difference between producer clocks and the recording service (5 minutes). */
export const MAX_CLOCK_SKEW_MS = 300_000;

const PLATFORM_TYPES = new Set(['grant', 'decision', 'decision_consumption', 'revocation']);
const ID_FIELDS: Record<string, string> = {
  run_context: 'run_id',
  tool_call: 'call_id',
  policy_evaluation: 'evaluation_id',
  recommendation: 'recommendation_id',
  disposition: 'disposition_id',
};

const entryPath = (index: number, rest = ''): string => `entries[${index}]${rest ? `.${rest}` : ''}`;

function fail(code: VerificationCodeValue, message: string, index: number | null, path: string, expected: string | null = null, actual: string | null = null): VerificationFailure {
  return new VerificationFailure(code, message, { entryIndex: index, fieldPath: path, expected, actual });
}

// ── Privacy ──────────────────────────────────────────────────────────────

function evidenceRefs(data: Json, kind: string): Array<[string, Json]> {
  const refs: Array<[string, Json]> = [];
  if (kind === 'policy_evaluation') {
    (data['inputs'] as Json[]).forEach((item, i) => (item['evidence'] as Json[]).forEach((ref, j) => refs.push([`data.inputs[${i}].evidence[${j}]`, ref])));
  } else if (kind === 'recommendation') {
    (data['sections'] as Json[]).forEach((section, i) => (section['evidence'] as Json[]).forEach((ref, j) => refs.push([`data.sections[${i}].evidence[${j}]`, ref])));
  } else if (kind === 'disposition') {
    (data['comparisons'] as Json[]).forEach((comparison, i) => (comparison['evidence'] as Json[]).forEach((ref, j) => refs.push([`data.comparisons[${i}].evidence[${j}]`, ref])));
    refs.push(['data.hit', data['hit'] as Json]);
  }
  return refs;
}

export function checkPrivacy(pkg: Json): void {
  const privacy = pkg['privacy'] as Json;
  const disclosed = privacy['disclosed'] as string[];
  if (disclosed.join('\n') !== [...disclosed].sort().join('\n')) {
    throw fail(Code.PRIVACY_VIOLATION, 'privacy.disclosed must be sorted', null, 'privacy.disclosed');
  }
  const all = disclosed.join('\n') === IDENTIFIER_CLASSES.join('\n');
  if (privacy['scheme'] === 'none') {
    if (!all) throw fail(Code.PRIVACY_VIOLATION, 'scheme none requires every class to be disclosed', null, 'privacy.disclosed');
    if ('key_id' in privacy) throw fail(Code.PRIVACY_VIOLATION, 'scheme none has no key_id', null, 'privacy.key_id');
  } else {
    if (!('key_id' in privacy)) throw fail(Code.PRIVACY_VIOLATION, 'a pseudonymisation scheme requires key_id', null, 'privacy.key_id');
    if (all) throw fail(Code.PRIVACY_VIOLATION, 'every class is disclosed; the scheme must be none', null, 'privacy.scheme');
  }
  const identifier = (cls: string, value: unknown, index: number | null, path: string): void => {
    if (!disclosed.includes(cls) && !isPseudonym(value)) {
      throw fail(Code.PRIVACY_VIOLATION, `${cls} value is not pseudonymised and ${cls} is not disclosed`, index, path);
    }
  };
  const content = (value: unknown, index: number, path: string): void => {
    if (value === null) return;
    const wanted = disclosed.includes('content') ? 'sha256:' : 'hmac-sha256:';
    if (!String(value).startsWith(wanted)) {
      throw fail(Code.PRIVACY_VIOLATION, `content digest must be ${wanted} while content is ${wanted === 'sha256:' ? 'disclosed' : 'not disclosed'}`, index, path);
    }
  };
  const actionKey = (data: Json, index: number): void => {
    if (disclosed.includes('subject')) {
      if (!('action_hash' in data)) throw fail(Code.PRIVACY_VIOLATION, 'action_hash is required when the subject is disclosed', index, entryPath(index, 'data.action_hash'));
      if ('action_ref' in data) throw fail(Code.PRIVACY_VIOLATION, 'action_ref is used only while the subject is pseudonymised', index, entryPath(index, 'data.action_ref'));
    } else {
      if ('action_hash' in data) throw fail(Code.PRIVACY_VIOLATION, 'an unkeyed action_hash would reveal the pseudonymised subject', index, entryPath(index, 'data.action_hash'));
      if (!isActionReference(data['action_ref'])) throw fail(Code.PRIVACY_VIOLATION, 'action_ref is required while the subject is pseudonymised', index, entryPath(index, 'data.action_ref'));
    }
  };

  const kase = pkg['case'] as Json;
  if ('subject' in kase) identifier('subject', kase['subject'], null, 'case.subject');
  (pkg['entries'] as Json[]).forEach((entry, index) => {
    const kind = entry['type'] as string;
    const data = entry['data'] as Json;
    if (kind === 'grant') {
      identifier('principal', data['principal'], index, entryPath(index, 'data.principal'));
    } else if (kind === 'tool_call') {
      content(data['input_hash'], index, entryPath(index, 'data.input_hash'));
      content(data['output_hash'], index, entryPath(index, 'data.output_hash'));
      (data['upstream_records'] as Json[]).forEach((record, k) => identifier('record', record['record_id'], index, entryPath(index, `data.upstream_records[${k}].record_id`)));
    } else if (kind === 'decision') {
      identifier('subject', data['action']['subject'], index, entryPath(index, 'data.action.subject'));
      actionKey(data, index);
      identifier('approver', data['approver'], index, entryPath(index, 'data.approver'));
    } else if (kind === 'decision_consumption') {
      actionKey(data, index);
    }
    for (const [path, ref] of evidenceRefs(data, kind)) {
      if ('excerpt_ref' in ref) identifier('record', ref['excerpt_ref'], index, entryPath(index, `${path}.excerpt_ref`));
      identifier('record', ref['record_id'], index, entryPath(index, `${path}.record_id`));
    }
  });
}

// ── Chain ────────────────────────────────────────────────────────────────

export function checkChain(pkg: Json): void {
  const chain = pkg['chain'] as Json;
  const entries = pkg['entries'] as Json[];
  const genesis = headerHash(pkg);
  if (chain['genesis'] !== genesis) throw fail(Code.GENESIS_MISMATCH, 'chain.genesis is not the hash of the package header', null, 'chain.genesis', genesis, chain['genesis']);
  let previous = genesis;
  entries.forEach((entry, index) => {
    if (entry['seq'] !== index) throw fail(Code.SEQUENCE_MISMATCH, `entry ${index} has seq ${String(entry['seq'])}`, index, entryPath(index, 'seq'), String(index), String(entry['seq']));
    if (entry['prev'] !== previous) throw fail(Code.LINK_MISMATCH, `entry ${index} does not link to the hash before it`, index, entryPath(index, 'prev'), previous, entry['prev']);
    const computed = entryHash(entry);
    if (entry['hash'] !== computed) throw fail(Code.ENTRY_HASH_MISMATCH, `entry ${index} content does not match its hash`, index, entryPath(index, 'hash'), computed, entry['hash']);
    previous = computed;
  });
  if (chain['head'] !== previous) throw fail(Code.HEAD_MISMATCH, 'chain.head is not the hash of the last entry', null, 'chain.head', previous, chain['head']);
  if (chain['length'] !== entries.length) throw fail(Code.LENGTH_MISMATCH, 'chain.length is not the number of entries', null, 'chain.length', String(entries.length), String(chain['length']));
  const root = chainRoot(chain);
  if (chain['root'] !== root) throw fail(Code.ROOT_MISMATCH, 'chain.root is not the hash of the chain summary', null, 'chain.root', root, chain['root']);
}

// ── Cross-entry rules ────────────────────────────────────────────────────

export interface SemanticSummary {
  unsourcedInputs: number;
  lateEntries: number;
  tenantAssertedEntries: number;
}

interface State {
  grants: Map<string, [number, number]>;
  grantRevokedAt: Map<string, string | null>;
  records: Map<string, Json>;
  voided: Set<string>;
  decisions: Map<string, Json>;
  consumed: Set<string>;
  allCallIds: Set<string>;
  consumptionSeen: boolean;
}

const recordKey = (kind: string, id: string): string => `${kind}\n${id}`;
const actionKeyOf = (data: Json): unknown => ('action_hash' in data ? data['action_hash'] : data['action_ref']);
const actionPath = (data: Json): string => ('action_hash' in data ? 'data.action_hash' : 'data.action_ref');

export function checkSemantics(pkg: Json): SemanticSummary {
  const kase = pkg['case'] as Json;
  const disclosed = pkg['privacy']['disclosed'] as string[];
  const entries = pkg['entries'] as Json[];
  const state: State = {
    grants: new Map(), grantRevokedAt: new Map(), records: new Map(), voided: new Set(),
    decisions: new Map(), consumed: new Set(), allCallIds: new Set(), consumptionSeen: false,
  };
  const summary: SemanticSummary = { unsourcedInputs: 0, lateEntries: 0, tenantAssertedEntries: 0 };
  for (const entry of entries) if (entry['type'] === 'tool_call') state.allCallIds.add(entry['data']['call_id']);

  let grantBlock = true;
  let lastGrant: string | null = null;
  let lastRecorded: number | null = null;
  entries.forEach((entry, index) => {
    const kind = entry['type'] as string;
    const data = entry['data'] as Json;
    const source = entry['source'] as Json;
    const at = timestampMs(entry['at']);
    const recorded = timestampMs(source['recorded_at']);

    if (PLATFORM_TYPES.has(kind) && source['authority'] !== 'platform') {
      throw fail(Code.AUTHORITY_VIOLATION, `a ${kind} entry must be recorded by the platform`, index, entryPath(index, 'source.authority'), 'platform', source['authority']);
    }
    if (source['authority'] === 'tenant') summary.tenantAssertedEntries += 1;
    if (source['late'] === true) summary.lateEntries += 1;
    if (at > recorded + MAX_CLOCK_SKEW_MS) {
      throw fail(Code.VALIDITY_VIOLATION, 'entry time is later than when it was recorded', index, entryPath(index, 'at'), `<= ${String(source['recorded_at'])} + ${MAX_CLOCK_SKEW_MS} ms`, entry['at']);
    }

    if (kind === 'grant') {
      checkGrant(entry, index, grantBlock, lastGrant, state);
      lastGrant = data['grant_id'];
      return;
    }
    if (index === 0) throw fail(Code.GRANT_CHAIN_BROKEN, 'the first entry must be the root grant', 0, entryPath(0, 'type'));
    grantBlock = false;
    if (lastRecorded !== null && recorded < lastRecorded) {
      throw fail(Code.ENTRIES_OUT_OF_ORDER, 'entries after the grant chain must be in recording order', index, entryPath(index, 'source.recorded_at'));
    }
    lastRecorded = recorded;
    if (state.consumptionSeen && source['authority'] === 'tenant' && source['late'] !== true) {
      throw fail(Code.VALIDITY_VIOLATION, 'a tenant record made after the decision was consumed must be marked late', index, entryPath(index, 'source.late'), 'true', null);
    }

    const idField = ID_FIELDS[kind];
    if (idField !== undefined) {
      if (state.records.has(recordKey(kind, data[idField]))) {
        throw fail(Code.DUPLICATE_IDENTIFIER, `${String(data[idField])} appears in more than one entry`, index, entryPath(index, `data.${idField}`));
      }
      if ('run_id' in data && kind !== 'run_context') requireRecord(state, 'run_context', data['run_id'], index, 'data.run_id');
    }
    if (kind === 'tool_call') {
      checkToolCall(data, index, at, state);
    } else if (kind === 'policy_evaluation') {
      (data['inputs'] as Json[]).forEach((item, i) => {
        if (((item['evidence'] as unknown[]).length > 0) === (item['unsourced'] === true)) {
          throw fail(Code.SCHEMA_VIOLATION, 'an input cites evidence or is marked unsourced, not both or neither', index, entryPath(index, `data.inputs[${i}].unsourced`));
        }
        if (item['unsourced'] === true) summary.unsourcedInputs += 1;
      });
    } else if (kind === 'recommendation') {
      (data['evaluation_ids'] as string[]).forEach((id, i) => requireRecord(state, 'policy_evaluation', id, index, `data.evaluation_ids[${i}]`));
      (data['sections'] as Json[]).forEach((section, i) => {
        if (section['status'] !== 'not_available' && (section['evidence'] as unknown[]).length === 0) {
          throw fail(Code.SCHEMA_VIOLATION, 'a section that is not not_available must cite evidence', index, entryPath(index, `data.sections[${i}].evidence`));
        }
      });
    } else if (kind === 'decision') {
      checkDecision(data, index, kase, disclosed, state);
    } else if (kind === 'decision_consumption') {
      checkConsumption(data, index, state);
    } else if (kind === 'revocation') {
      if (!state.grants.has(data['grant_id'])) throw fail(Code.DANGLING_REFERENCE, 'revoked grant is not in the grant chain', index, entryPath(index, 'data.grant_id'));
      const revokedAt = state.grantRevokedAt.get(data['grant_id']) ?? null;
      if (revokedAt !== data['revoked_at']) {
        throw fail(Code.VALIDITY_VIOLATION, "revocation time differs from the grant's revoked_at", index, entryPath(index, 'data.revoked_at'), revokedAt, data['revoked_at']);
      }
    } else if (kind === 'void') {
      const target = recordKey(data['target_type'], data['target_id']);
      if (!state.records.has(target)) throw fail(Code.DANGLING_REFERENCE, 'void names no earlier record', index, entryPath(index, 'data.target_id'));
      if (state.voided.has(target)) throw fail(Code.DUPLICATE_IDENTIFIER, 'record is already void', index, entryPath(index, 'data.target_id'));
      state.voided.add(target);
    }

    for (const [path, ref] of evidenceRefs(data, kind)) checkRef(ref, index, path, state);
    if (idField !== undefined) state.records.set(recordKey(kind, data[idField]), data);
  });
  return summary;
}

function requireRecord(state: State, kind: string, id: string, index: number, path: string): Json {
  const record = state.records.get(recordKey(kind, id));
  if (!record) throw fail(Code.DANGLING_REFERENCE, `no earlier ${kind} has this id`, index, entryPath(index, path));
  if (state.voided.has(recordKey(kind, id))) throw fail(Code.DANGLING_REFERENCE, `${kind} ${id} is void`, index, entryPath(index, path));
  return record;
}

function checkGrant(entry: Json, index: number, grantBlock: boolean, lastGrant: string | null, state: State): void {
  const data = entry['data'] as Json;
  if (!grantBlock) throw fail(Code.GRANT_CHAIN_BROKEN, 'grant entries must come first, root to leaf', index, entryPath(index, 'type'));
  if (state.grants.has(data['grant_id'])) throw fail(Code.DUPLICATE_IDENTIFIER, `${String(data['grant_id'])} appears in more than one entry`, index, entryPath(index, 'data.grant_id'));
  if (data['depth'] !== index) throw fail(Code.GRANT_CHAIN_BROKEN, `grant at position ${index} has depth ${String(data['depth'])}`, index, entryPath(index, 'data.depth'), String(index), String(data['depth']));
  if (data['parent_grant_id'] !== lastGrant) throw fail(Code.GRANT_CHAIN_BROKEN, 'parent_grant_id is not the previous grant in the chain', index, entryPath(index, 'data.parent_grant_id'), lastGrant, data['parent_grant_id']);
  if (entry['at'] !== data['issued_at']) throw fail(Code.GRANT_CHAIN_BROKEN, "a grant entry's time is the grant's issue time", index, entryPath(index, 'at'), data['issued_at'], entry['at']);
  const issued = timestampMs(data['issued_at']);
  const expires = timestampMs(data['expires_at']);
  const revoked = data['revoked_at'] as string | null;
  if ((data['status'] === 'revoked') !== (revoked !== null)) throw fail(Code.VALIDITY_VIOLATION, 'revoked_at is set exactly when the grant is revoked', index, entryPath(index, 'data.revoked_at'));
  if (expires < issued) throw fail(Code.VALIDITY_VIOLATION, 'grant expires before it was issued', index, entryPath(index, 'data.expires_at'));
  let end = expires;
  if (revoked !== null) {
    if (timestampMs(revoked) < issued) throw fail(Code.VALIDITY_VIOLATION, 'grant revoked before it was issued', index, entryPath(index, 'data.revoked_at'));
    end = Math.min(end, timestampMs(revoked));
  }
  if (lastGrant !== null) {
    const [parentIssued, parentEnd] = state.grants.get(lastGrant)!;
    if (issued < parentIssued - MAX_CLOCK_SKEW_MS || issued > parentEnd + MAX_CLOCK_SKEW_MS) {
      throw fail(Code.VALIDITY_VIOLATION, "delegated grant issued outside its parent's validity", index, entryPath(index, 'data.issued_at'));
    }
  }
  state.grants.set(data['grant_id'], [issued, end]);
  state.grantRevokedAt.set(data['grant_id'], revoked);
}

function checkRef(ref: Json, index: number, path: string, state: State): void {
  const call = state.records.get(recordKey('tool_call', ref['call_id']));
  if (!call) throw fail(Code.DANGLING_REFERENCE, 'evidence cites no earlier tool call', index, entryPath(index, `${path}.call_id`));
  if (state.voided.has(recordKey('tool_call', ref['call_id']))) throw fail(Code.DANGLING_REFERENCE, 'evidence cites a void tool call', index, entryPath(index, `${path}.call_id`));
  if (call['provider'] !== ref['provider']) throw fail(Code.DANGLING_REFERENCE, 'evidence provider differs from the tool call', index, entryPath(index, `${path}.provider`));
  const records = call['upstream_records'] as Json[];
  if (!records.some((r) => r['record_id'] === ref['record_id'])) throw fail(Code.DANGLING_REFERENCE, 'the tool call returned no such upstream record', index, entryPath(index, `${path}.record_id`));
  if (!records.some((r) => r['record_id'] === ref['record_id'] && r['retrieved_at'] === ref['retrieved_at'])) {
    throw fail(Code.DANGLING_REFERENCE, 'evidence retrieval time differs from the upstream record', index, entryPath(index, `${path}.retrieved_at`));
  }
}

function checkToolCall(data: Json, index: number, at: number, state: State): void {
  if (!state.grants.has(data['grant_id'])) throw fail(Code.DANGLING_REFERENCE, 'tool call grant is not in the grant chain', index, entryPath(index, 'data.grant_id'));
  const inconsistent = (path: string, message: string): VerificationFailure => fail(Code.TOOL_CALL_INCONSISTENT, message, index, entryPath(index, path));
  const outcome = data['outcome'];
  if (outcome === 'allowed') {
    if ('denial' in data) throw inconsistent('data.denial', 'an allowed call has no denial');
    if (data['output_hash'] === null) throw inconsistent('data.output_hash', 'an allowed call has an output hash');
  } else {
    if (outcome === 'denied' && !('denial' in data)) throw inconsistent('data.denial', 'a denied call names its denial reason');
    if (outcome === 'error' && 'denial' in data) throw inconsistent('data.denial', 'a failed call has no denial');
    if (data['output_hash'] !== null) throw inconsistent('data.output_hash', 'a call that did not run has no output');
    if ((data['upstream_records'] as unknown[]).length > 0) throw inconsistent('data.upstream_records', 'a call that did not run has no upstream records');
  }
  if ('completed_at' in data && timestampMs(data['completed_at']) < timestampMs(data['started_at'])) throw inconsistent('data.completed_at', 'completed before it started');
  if (outcome === 'allowed') {
    const [issued, end] = state.grants.get(data['grant_id'])!;
    if (at < issued - MAX_CLOCK_SKEW_MS || at > end + MAX_CLOCK_SKEW_MS) {
      throw fail(Code.VALIDITY_VIOLATION, "an allowed call falls outside its grant's validity", index, entryPath(index, 'at'));
    }
  }
}

function checkDecision(data: Json, index: number, kase: Json, disclosed: string[], state: State): void {
  if (state.decisions.has(data['jti'])) throw fail(Code.DUPLICATE_IDENTIFIER, `${String(data['jti'])} appears in more than one entry`, index, entryPath(index, 'data.jti'));
  const action = data['action'] as Json;
  if (action['case_id'] !== kase['case_id']) throw fail(Code.CASE_MISMATCH, 'decision approves an action on another case', index, entryPath(index, 'data.action.case_id'), kase['case_id'], action['case_id']);
  if ('subject' in kase && action['subject'] !== kase['subject']) {
    throw fail(Code.CASE_MISMATCH, 'decision subject differs from the case subject', index, entryPath(index, 'data.action.subject'), kase['subject'], action['subject']);
  }
  if (disclosed.includes('subject')) {
    const computed = decisionActionHash(action);
    if (computed !== data['action_hash']) throw fail(Code.ACTION_HASH_MISMATCH, 'action_hash is not the hash of the semantic action', index, entryPath(index, 'data.action_hash'), computed, data['action_hash']);
  }
  const inconsistent = (path: string, message: string): VerificationFailure => fail(Code.DECISION_INCONSISTENT, message, index, entryPath(index, path));
  const position = data['approval_position'] as number;
  if (position > (data['approvals_required'] as number)) throw inconsistent('data.approval_position', 'more approvals than required');
  if (timestampMs(data['expires_at']) < timestampMs(data['issued_at'])) throw fail(Code.VALIDITY_VIOLATION, 'decision expires before it was issued', index, entryPath(index, 'data.expires_at'));
  if (position === 1) {
    if ('first_jti' in data) throw inconsistent('data.first_jti', 'a first approval has no first_jti');
  } else {
    if (!('first_jti' in data)) throw inconsistent('data.first_jti', 'a second approval names the first');
    const first = state.decisions.get(data['first_jti']);
    if (!first) throw fail(Code.DANGLING_REFERENCE, 'no earlier decision has this jti', index, entryPath(index, 'data.first_jti'));
    const checks: Array<[string, boolean]> = [
      ['data.first_jti', first['approval_position'] === 1],
      ['data.first_jti', !state.consumed.has(data['first_jti'])],
      [actionPath(data), actionKeyOf(first) === actionKeyOf(data)],
      ['data.approvals_required', first['approvals_required'] === 2],
      ['data.approver', first['approver'] !== data['approver']],
    ];
    for (const [path, ok] of checks) {
      if (!ok) throw inconsistent(path, 'second approval does not pair with an unconsumed first approval');
    }
  }
  state.decisions.set(data['jti'], data);
}

function checkConsumption(data: Json, index: number, state: State): void {
  const consumedAt = timestampMs(data['consumed_at']);
  const decisions: Json[] = [];
  (data['jtis'] as string[]).forEach((jti, position) => {
    const path = `data.jtis[${position}]`;
    const decision = state.decisions.get(jti);
    if (!decision) throw fail(Code.DANGLING_REFERENCE, 'no earlier decision has this jti', index, entryPath(index, path));
    if (state.consumed.has(jti)) throw fail(Code.DECISION_INCONSISTENT, 'decision grant consumed more than once', index, entryPath(index, path));
    if (actionKeyOf(decision) !== actionKeyOf(data)) {
      throw fail(Code.DECISION_INCONSISTENT, 'consumed decision approved a different action', index, entryPath(index, actionPath(data)), String(actionKeyOf(decision)), String(actionKeyOf(data)));
    }
    if (consumedAt > timestampMs(decision['expires_at']) || consumedAt < timestampMs(decision['issued_at']) - MAX_CLOCK_SKEW_MS) {
      throw fail(Code.VALIDITY_VIOLATION, "consumed outside the decision grant's validity", index, entryPath(index, 'data.consumed_at'), `${String(decision['issued_at'])}..${String(decision['expires_at'])}`, data['consumed_at']);
    }
    decisions.push(decision);
  });
  const required = decisions[0]!['approvals_required'] as number;
  const positions = decisions.map((d) => d['approval_position'] as number).sort((a, b) => a - b);
  const expectedPositions = Array.from({ length: required }, (_, i) => i + 1);
  if (decisions.some((d) => d['approvals_required'] !== required) || positions.join(',') !== expectedPositions.join(',')) {
    throw fail(Code.DECISION_INCONSISTENT, 'a consumption presents every required approval exactly once', index, entryPath(index, 'data.jtis'), String(required), String(decisions.length));
  }
  if ('call_id' in data && !state.allCallIds.has(data['call_id'])) throw fail(Code.DANGLING_REFERENCE, 'no tool call has this call_id', index, entryPath(index, 'data.call_id'));
  for (const jti of data['jtis'] as string[]) state.consumed.add(jti);
  state.consumptionSeen = true;
}
