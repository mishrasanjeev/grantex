/**
 * Privacy, hash-chain and cross-entry checks on a parsed evidence package.
 * Each check throws `VerificationFailure` at the first problem. The order of
 * checks is part of the specification and matches the Python SDK.
 */
import { IDENTIFIER_CLASSES, chainRoot, decisionActionHash, entryHash, headerHash, isPseudonym } from './hashing.js';
import { VerificationCode as Code, VerificationFailure, type FailureLocation } from './result.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const entryPath = (index: number, rest = ''): string => `entries[${index}]${rest ? `.${rest}` : ''}`;

function failure(code: (typeof Code)[keyof typeof Code], message: string, location: FailureLocation): VerificationFailure {
  return new VerificationFailure(code, message, location);
}

export function checkPrivacy(pkg: Json): void {
  const privacy = pkg['privacy'] as Json;
  const disclosed = privacy['disclosed'] as string[];
  if (disclosed.join('\n') !== [...disclosed].sort().join('\n')) {
    throw failure(Code.PRIVACY_VIOLATION, 'privacy.disclosed must be sorted', { fieldPath: 'privacy.disclosed' });
  }
  const everything = IDENTIFIER_CLASSES.join('\n');
  const all = disclosed.join('\n') === everything;
  if (privacy['scheme'] === 'none') {
    if (!all) {
      throw failure(Code.PRIVACY_VIOLATION, 'scheme none requires every identifier class to be disclosed', { fieldPath: 'privacy.disclosed' });
    }
    if ('key_id' in privacy) {
      throw failure(Code.PRIVACY_VIOLATION, 'scheme none has no key_id', { fieldPath: 'privacy.key_id' });
    }
  } else {
    if (!('key_id' in privacy)) {
      throw failure(Code.PRIVACY_VIOLATION, 'a pseudonymisation scheme requires key_id', { fieldPath: 'privacy.key_id' });
    }
    if (all) {
      throw failure(Code.PRIVACY_VIOLATION, 'every identifier class is disclosed; the scheme must be none', { fieldPath: 'privacy.scheme' });
    }
  }
  const require = (cls: string, value: unknown, path: string): void => {
    if (!disclosed.includes(cls) && !isPseudonym(value)) {
      throw failure(Code.PRIVACY_VIOLATION, `${cls} identifier is not pseudonymised and ${cls} is not disclosed`, { fieldPath: path });
    }
  };
  const kase = pkg['case'] as Json;
  if ('subject' in kase) require('subject', kase['subject'], 'case.subject');
  (pkg['entries'] as Json[]).forEach((entry, index) => {
    const data = entry['data'] as Json;
    if (entry['type'] === 'grant') {
      require('principal', data['principal'], entryPath(index, 'data.principal'));
    } else if (entry['type'] === 'decision') {
      require('subject', data['action']['subject'], entryPath(index, 'data.action.subject'));
      require('approver', data['approver'], entryPath(index, 'data.approver'));
    }
  });
}

export function checkChain(pkg: Json): void {
  const chain = pkg['chain'] as Json;
  const entries = pkg['entries'] as Json[];
  const genesis = headerHash(pkg);
  if (chain['genesis'] !== genesis) {
    throw failure(Code.GENESIS_MISMATCH, 'chain.genesis is not the hash of the package header', {
      fieldPath: 'chain.genesis', expected: genesis, actual: chain['genesis'],
    });
  }
  let previous = genesis;
  entries.forEach((entry, index) => {
    if (entry['seq'] !== index) {
      throw failure(Code.SEQUENCE_MISMATCH, `entry ${index} has seq ${String(entry['seq'])}`, {
        entryIndex: index, fieldPath: entryPath(index, 'seq'), expected: String(index), actual: String(entry['seq']),
      });
    }
    if (entry['prev'] !== previous) {
      throw failure(Code.LINK_MISMATCH, `entry ${index} does not link to the hash before it`, {
        entryIndex: index, fieldPath: entryPath(index, 'prev'), expected: previous, actual: entry['prev'],
      });
    }
    const computed = entryHash(entry);
    if (entry['hash'] !== computed) {
      throw failure(Code.ENTRY_HASH_MISMATCH, `entry ${index} content does not match its hash`, {
        entryIndex: index, fieldPath: entryPath(index, 'hash'), expected: computed, actual: entry['hash'],
      });
    }
    previous = computed;
  });
  if (chain['head'] !== previous) {
    throw failure(Code.HEAD_MISMATCH, 'chain.head is not the hash of the last entry', {
      fieldPath: 'chain.head', expected: previous, actual: chain['head'],
    });
  }
  if (chain['length'] !== entries.length) {
    throw failure(Code.LENGTH_MISMATCH, 'chain.length is not the number of entries', {
      fieldPath: 'chain.length', expected: String(entries.length), actual: String(chain['length']),
    });
  }
  const root = chainRoot(chain);
  if (chain['root'] !== root) {
    throw failure(Code.ROOT_MISMATCH, 'chain.root is not the hash of the chain summary', {
      fieldPath: 'chain.root', expected: root, actual: chain['root'],
    });
  }
}

interface Index {
  grants: Set<string>;
  runs: Set<string>;
  calls: Map<string, Json>;
  evaluations: Set<string>;
  recommendations: Set<string>;
  decisions: Map<string, Json>;
  allCallIds: Set<string>;
}

function unique(seen: { has(value: string): boolean }, value: string, index: number, path: string): void {
  if (seen.has(value)) {
    throw failure(Code.DUPLICATE_IDENTIFIER, `${value} appears in more than one entry`, { entryIndex: index, fieldPath: entryPath(index, path) });
  }
}

function dangling(index: number, path: string, message: string): VerificationFailure {
  return failure(Code.DANGLING_REFERENCE, message, { entryIndex: index, fieldPath: entryPath(index, path) });
}

function checkEvidence(refs: Json[], index: number, base: string, known: Index): void {
  refs.forEach((ref, position) => {
    const path = `${base}[${position}]`;
    const call = known.calls.get(ref['call_id'] as string);
    if (!call) throw dangling(index, `${path}.call_id`, 'evidence cites no earlier tool call');
    if (call['provider'] !== ref['provider']) {
      throw dangling(index, `${path}.provider`, 'evidence provider differs from the tool call');
    }
    const records = call['upstream_records'] as Json[];
    if (!records.some((r) => r['record_id'] === ref['record_id'])) {
      throw dangling(index, `${path}.record_id`, 'the tool call returned no such upstream record');
    }
    if (!records.some((r) => r['record_id'] === ref['record_id'] && r['retrieved_at'] === ref['retrieved_at'])) {
      throw dangling(index, `${path}.retrieved_at`, 'evidence retrieval time differs from the upstream record');
    }
  });
}

export function checkSemantics(pkg: Json): void {
  const kase = pkg['case'] as Json;
  const disclosed = pkg['privacy']['disclosed'] as string[];
  const entries = pkg['entries'] as Json[];
  const known: Index = {
    grants: new Set(), runs: new Set(), calls: new Map(), evaluations: new Set(),
    recommendations: new Set(), decisions: new Map(), allCallIds: new Set(),
  };
  for (const entry of entries) {
    if (entry['type'] === 'tool_call') known.allCallIds.add(entry['data']['call_id'] as string);
  }

  let grantBlock = true;
  let lastGrant: string | null = null;
  let lastAt: string | null = null;
  entries.forEach((entry, index) => {
    const kind = entry['type'] as string;
    const data = entry['data'] as Json;
    if (kind === 'grant') {
      if (!grantBlock) {
        throw failure(Code.GRANT_CHAIN_BROKEN, 'grant entries must come first, root to leaf', { entryIndex: index, fieldPath: entryPath(index, 'type') });
      }
      unique(known.grants, data['grant_id'], index, 'data.grant_id');
      if (data['depth'] !== index) {
        throw failure(Code.GRANT_CHAIN_BROKEN, `grant at position ${index} has depth ${String(data['depth'])}`, {
          entryIndex: index, fieldPath: entryPath(index, 'data.depth'), expected: String(index), actual: String(data['depth']),
        });
      }
      if (data['parent_grant_id'] !== lastGrant) {
        throw failure(Code.GRANT_CHAIN_BROKEN, 'parent_grant_id is not the previous grant in the chain', {
          entryIndex: index, fieldPath: entryPath(index, 'data.parent_grant_id'), expected: lastGrant, actual: data['parent_grant_id'],
        });
      }
      if (entry['at'] !== data['issued_at']) {
        throw failure(Code.GRANT_CHAIN_BROKEN, "a grant entry's time is the grant's issue time", {
          entryIndex: index, fieldPath: entryPath(index, 'at'), expected: data['issued_at'], actual: entry['at'],
        });
      }
      known.grants.add(data['grant_id']);
      lastGrant = data['grant_id'];
      return;
    }
    if (index === 0) {
      throw failure(Code.GRANT_CHAIN_BROKEN, 'the first entry must be the root grant', { entryIndex: 0, fieldPath: entryPath(0, 'type') });
    }
    grantBlock = false;
    if (lastAt !== null && (entry['at'] as string) < lastAt) {
      throw failure(Code.ENTRIES_OUT_OF_ORDER, 'entries after the grant chain must be in time order', {
        entryIndex: index, fieldPath: entryPath(index, 'at'), expected: lastAt, actual: entry['at'],
      });
    }
    lastAt = entry['at'] as string;

    if (kind === 'run_context') {
      unique(known.runs, data['run_id'], index, 'data.run_id');
      known.runs.add(data['run_id']);
    } else if (kind === 'tool_call') {
      checkToolCall(data, index, known);
    } else if (kind === 'policy_evaluation') {
      unique(known.evaluations, data['evaluation_id'], index, 'data.evaluation_id');
      if ('run_id' in data && !known.runs.has(data['run_id'])) {
        throw dangling(index, 'data.run_id', 'no earlier run_context has this run_id');
      }
      (data['inputs'] as Json[]).forEach((item, position) => {
        checkEvidence(item['evidence'] as Json[], index, `data.inputs[${position}].evidence`, known);
      });
      known.evaluations.add(data['evaluation_id']);
    } else if (kind === 'recommendation') {
      unique(known.recommendations, data['recommendation_id'], index, 'data.recommendation_id');
      if (!known.evaluations.has(data['evaluation_id'])) {
        throw dangling(index, 'data.evaluation_id', 'no earlier policy_evaluation has this id');
      }
      (data['sections'] as Json[]).forEach((section, position) => {
        const base = `data.sections[${position}].evidence`;
        const evidence = section['evidence'] as Json[];
        if (section['status'] !== 'not_available' && evidence.length === 0) {
          throw failure(Code.SCHEMA_VIOLATION, 'a section that is not not_available must cite evidence', {
            entryIndex: index, fieldPath: entryPath(index, base),
          });
        }
        checkEvidence(evidence, index, base, known);
      });
      known.recommendations.add(data['recommendation_id']);
    } else if (kind === 'decision') {
      checkDecision(data, index, kase, disclosed, known);
    } else if (kind === 'decision_consumption') {
      (data['jtis'] as string[]).forEach((jti, position) => {
        const decision = known.decisions.get(jti);
        const path = `data.jtis[${position}]`;
        if (!decision) throw dangling(index, path, 'no earlier decision has this jti');
        if (decision['action_hash'] !== data['action_hash']) {
          throw failure(Code.DECISION_INCONSISTENT, 'consumed decision approved a different action', {
            entryIndex: index, fieldPath: entryPath(index, 'data.action_hash'), expected: decision['action_hash'], actual: data['action_hash'],
          });
        }
      });
      if ('call_id' in data && !known.allCallIds.has(data['call_id'])) {
        throw dangling(index, 'data.call_id', 'no tool call has this call_id');
      }
    } else if (kind === 'revocation') {
      if (!known.grants.has(data['grant_id'])) {
        throw dangling(index, 'data.grant_id', 'revoked grant is not in the grant chain');
      }
    }
  });
}

function checkToolCall(data: Json, index: number, known: Index): void {
  unique(known.calls, data['call_id'], index, 'data.call_id');
  if (!known.grants.has(data['grant_id'])) throw dangling(index, 'data.grant_id', 'tool call grant is not in the grant chain');
  if ('run_id' in data && !known.runs.has(data['run_id'])) throw dangling(index, 'data.run_id', 'no earlier run_context has this run_id');
  const inconsistent = (path: string, message: string): VerificationFailure =>
    failure(Code.TOOL_CALL_INCONSISTENT, message, { entryIndex: index, fieldPath: entryPath(index, path) });

  const outcome = data['outcome'];
  if (outcome === 'allowed') {
    if ('denial' in data) throw inconsistent('data.denial', 'an allowed call has no denial');
    if (data['output_hash'] === null) throw inconsistent('data.output_hash', 'an allowed call has an output hash');
  } else {
    if (outcome === 'denied' && !('denial' in data)) throw inconsistent('data.denial', 'a denied call names its denial reason');
    if (outcome === 'error' && 'denial' in data) throw inconsistent('data.denial', 'a failed call has no denial');
    if (data['output_hash'] !== null) throw inconsistent('data.output_hash', 'a call that did not run has no output');
    if ((data['upstream_records'] as unknown[]).length > 0) {
      throw inconsistent('data.upstream_records', 'a call that did not run has no upstream records');
    }
  }
  if ('completed_at' in data && data['completed_at'] < data['started_at']) {
    throw inconsistent('data.completed_at', 'completed before it started');
  }
  known.calls.set(data['call_id'], data);
}

function checkDecision(data: Json, index: number, kase: Json, disclosed: string[], known: Index): void {
  unique(known.decisions, data['jti'], index, 'data.jti');
  const action = data['action'] as Json;
  if (action['case_id'] !== kase['case_id']) {
    throw failure(Code.CASE_MISMATCH, 'decision approves an action on another case', {
      entryIndex: index, fieldPath: entryPath(index, 'data.action.case_id'), expected: kase['case_id'], actual: action['case_id'],
    });
  }
  if (disclosed.includes('subject')) {
    const computed = decisionActionHash(action);
    if (computed !== data['action_hash']) {
      throw failure(Code.ACTION_HASH_MISMATCH, 'action_hash is not the hash of the semantic action', {
        entryIndex: index, fieldPath: entryPath(index, 'data.action_hash'), expected: computed, actual: data['action_hash'],
      });
    }
  }
  const inconsistent = (path: string, message: string): VerificationFailure =>
    failure(Code.DECISION_INCONSISTENT, message, { entryIndex: index, fieldPath: entryPath(index, path) });
  const position = data['approval_position'] as number;
  if (position > (data['approvals_required'] as number)) throw inconsistent('data.approval_position', 'more approvals than required');
  if (data['expires_at'] < data['issued_at']) throw inconsistent('data.expires_at', 'expires before it was issued');
  if (position === 1) {
    if ('first_jti' in data) throw inconsistent('data.first_jti', 'a first approval has no first_jti');
  } else {
    if (!('first_jti' in data)) throw inconsistent('data.first_jti', 'a second approval names the first');
    const first = known.decisions.get(data['first_jti']);
    if (!first) throw dangling(index, 'data.first_jti', 'no earlier decision has this jti');
    const pairs: Array<[string, boolean]> = [
      ['data.action_hash', first['action_hash'] === data['action_hash']],
      ['data.approvals_required', first['approvals_required'] === 2],
      ['data.approver', first['approver'] !== data['approver']],
    ];
    for (const [path, ok] of pairs) {
      if (!ok) throw inconsistent(path, 'second approval does not pair with the first approval');
    }
  }
  known.decisions.set(data['jti'], data);
}
