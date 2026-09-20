/**
 * Decision-grant semantic action and action_hash (PRD G-3, canonicalisation
 * stability). Cases in spec/examples/decision-grant/action-hash.json are
 * shared with the Python SDK and the auth service.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTION_HASH_PREFIX,
  ActionValidationError,
  canonicalActionJson,
  computeActionHash,
  decisionActionFromToolCall,
  isActionHash,
  parseDecisionAction,
  parseDecisionActionJson,
  type DecisionAction,
} from '../src/decisions/index.js';
import * as sdk from '../src/index.js';

interface Fixtures {
  valid: { name: string; action: DecisionAction; canonical: string; action_hash: string }[];
  equivalent_tool_calls: { tool: string; arguments: string[]; action_hash: string; extra_fields?: string[] }[];
  duplicate_keys: { name: string; action_json: string; code: string; field: string }[];
  invalid: { name: string; action?: unknown; action_json?: string; code: string; field: string }[];
}
const FIXTURES = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'spec', 'examples', 'decision-grant', 'action-hash.json'),
    'utf-8',
  ),
) as Fixtures;

const BASE: DecisionAction = { case_id: 'case_8841', action: 'case_decision', decision: 'approve', subject: 'gb:00000001' };

function thrown(fn: () => unknown): ActionValidationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ActionValidationError) return err;
    throw err;
  }
  throw new Error('expected ActionValidationError');
}

describe('shared action hashes', () => {
  it.each(FIXTURES.valid.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(canonicalActionJson(c.action)).toBe(c.canonical);
    expect(computeActionHash(c.action)).toBe(c.action_hash);
    expect(isActionHash(c.action_hash)).toBe(true);
    expect(parseDecisionAction(c.action)).toEqual(c.action);
  });

  it('are distinct', () => {
    const hashes = FIXTURES.valid.map((c) => c.action_hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it.each(FIXTURES.equivalent_tool_calls.map((g) => [g.tool, g] as const))('equivalent %s calls share one hash', (_tool, group) => {
    for (const text of group.arguments) {
      expect(computeActionHash(decisionActionFromToolCall(group.tool, JSON.parse(text), group.extra_fields ?? []))).toBe(group.action_hash);
    }
  });

  it.each(FIXTURES.invalid.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    const raw: unknown = c.action_json !== undefined ? JSON.parse(c.action_json) : c.action;
    const err = thrown(() => parseDecisionAction(raw));
    expect([err.code, err.field]).toEqual([c.code, c.field]);
    expect(() => computeActionHash(raw as DecisionAction)).toThrow(ActionValidationError);
  });
});

describe('action hash', () => {
  it('has the documented format', () => {
    const value = computeActionHash(BASE);
    expect(value.startsWith(ACTION_HASH_PREFIX)).toBe(true);
    expect(value).toHaveLength(ACTION_HASH_PREFIX.length + 43);
    expect(value).not.toContain('=');
    expect(isActionHash(`sha256:${'A'.repeat(42)}`)).toBe(false);
    expect(isActionHash(`sha512:${'A'.repeat(43)}`)).toBe(false);
    expect(isActionHash(undefined)).toBe(false);
  });

  it('is exported from the package entry point', () => {
    expect(sdk.computeActionHash(BASE)).toBe(computeActionHash(BASE));
    expect(sdk.canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('requires the semantic fields in a tool call', () => {
    expect([thrown(() => decisionActionFromToolCall('case_decision', { case_id: 'case_8841', decision: 'approve' })).field]).toEqual(['subject']);
    expect(thrown(() => decisionActionFromToolCall('case_decision', '{"case_id":"case_8841"}')).code).toBe('not_an_object');
    const err = thrown(() => decisionActionFromToolCall('case decision', { case_id: 'c', decision: 'approve', subject: 's' }));
    expect([err.code, err.field]).toEqual(['invalid_value', 'action']);
  });

  it('treats a number and a decimal string as different amounts', () => {
    expect(computeActionHash({ ...BASE, amount: 5 })).not.toBe(computeActionHash({ ...BASE, amount: '5' }));
    expect(computeActionHash({ ...BASE, amount: 5 })).toBe(computeActionHash({ ...BASE, amount: 5.0 }));
    expect(computeActionHash({ ...BASE, amount: 5 })).not.toBe(computeActionHash(BASE));
    expect(() => computeActionHash({ ...BASE, amount: NaN })).toThrow(ActionValidationError);
  });
});

describe('properties', () => {
  let seed = 3;
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const int = (lo: number, hi: number): number => lo + Math.floor(random() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  const text = (n: number): string => {
    let out = '';
    for (let i = 0; i < n; i++) {
      // U+00AD (soft hyphen) is an invisible format character, refused in actions.
      const [lo, hi] = pick([[0x20, 0x7e], [0xae, 0x24f], [0x1f600, 0x1f64f]] as const);
      out += String.fromCodePoint(int(lo, hi));
    }
    return out;
  };
  const randomSemantic = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      case_id: `case_${text(int(1, 20))}`,
      decision: pick(['approve', 'decline', 'close', 'file', 'request_info']),
      subject: pick(['gb:', 'us:', 'person:']) + text(int(1, 30)),
    };
    if (random() < 0.5) {
      out['amount'] = pick([int(0, 1e9), Math.round(random() * 1e8) / 100, `${int(1, 1e6)}${pick(['', '.5', '.25', '.01'])}`]);
    }
    return out;
  };
  const noise = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = int(0, 5); i > 0; i--) {
      out[`${pick(['requested_at', 'timestamp', 'plan_step', 'trace_id', 'note', 'retry'])}${i}`] = pick([
        `2026-09-${int(10, 28)}T${String(int(0, 23)).padStart(2, '0')}:00:00Z`,
        int(0, 1000),
        text(8),
        null,
        { nested: [1, 2, random()] },
      ]);
    }
    return out;
  };
  const reserialise = (payload: Record<string, unknown>): string => {
    const entries = Object.entries(payload);
    for (let i = entries.length - 1; i > 0; i--) {
      const j = int(0, i);
      [entries[i], entries[j]] = [entries[j]!, entries[i]!];
    }
    return JSON.stringify(Object.fromEntries(entries), null, pick([0, 2, 7]));
  };

  it('reordering, whitespace and new fields keep the hash', () => {
    for (let n = 0; n < 400; n++) {
      const tool = pick(['case_decision', 'monitor_delete', 'payout_release']);
      const semantic = randomSemantic();
      const expected = computeActionHash(decisionActionFromToolCall(tool, semantic));
      for (let k = 0; k < 5; k++) {
        const parsed: unknown = JSON.parse(reserialise({ ...noise(), ...semantic }));
        expect(computeActionHash(decisionActionFromToolCall(tool, parsed))).toBe(expected);
      }
      if (typeof semantic['amount'] === 'number') {
        // Another spelling of the same double.
        const spelled = JSON.stringify(semantic).replace(/"amount":[^,}]+/, `"amount":${(semantic['amount'] as number).toExponential()}`);
        expect(computeActionHash(decisionActionFromToolCall(tool, JSON.parse(spelled)))).toBe(expected);
      }
    }
  });

  it('any semantic change changes the hash', () => {
    for (let n = 0; n < 400; n++) {
      const tool = pick(['case_decision', 'monitor_delete']);
      const original = decisionActionFromToolCall(tool, randomSemantic());
      const baseHash = computeActionHash(original);
      const changed: Record<string, unknown> = { ...original };
      const field = pick(['case_id', 'action', 'decision', 'subject', 'amount'] as const);
      if (field === 'action') changed['action'] = `${tool}_v2`;
      else if (field === 'decision') changed['decision'] = `${original.decision}_x`;
      else if (field === 'amount') {
        const current = original.amount;
        if (current !== undefined && random() < 0.3) delete changed['amount'];
        else if (typeof current === 'string' && current.includes('.')) changed['amount'] = `${current}1`;
        else if (typeof current === 'number') changed['amount'] = current + 1;
        else changed['amount'] = 7;
      } else {
        const value = original[field];
        const chars = [...value];
        const last = chars.pop()!.codePointAt(0)! ^ 1;
        changed[field] = random() < 0.5 ? `${value}x` : chars.join('') + (last === 0x7f ? 'y' : String.fromCodePoint(last));
      }
      expect(computeActionHash(changed)).not.toBe(baseHash);
    }
  });
});

describe('follow-up rules', () => {
  it.each(FIXTURES.duplicate_keys.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    const err = thrown(() => parseDecisionActionJson(c.action_json));
    expect([err.code, err.field]).toEqual([c.code, c.field]);
  });

  it('parses a valid action from text', () => {
    expect(computeActionHash(parseDecisionActionJson(JSON.stringify(BASE)))).toBe(computeActionHash(BASE));
  });

  it('reads declared extra fields from the call', () => {
    const args = { case_id: 'case_8841', decision: 'approve', subject: 'gb:00000001', currency: 'GBP' };
    const withCurrency = decisionActionFromToolCall('payout_release', args, ['currency']);
    expect(withCurrency.extra).toEqual({ currency: 'GBP' });
    expect(computeActionHash(withCurrency)).not.toBe(computeActionHash(decisionActionFromToolCall('payout_release', args)));
    const err = thrown(() => decisionActionFromToolCall('payout_release', { ...args, currency: null }, ['currency']));
    expect([err.code, err.field]).toEqual(['missing_field', 'extra.currency']);
    expect(() => decisionActionFromToolCall('payout_release', args, ['subject'])).toThrow(ActionValidationError);
  });

  it.each([0x00ad, 0x061c, 0x180e, 0x200b, 0x200d, 0x202e, 0x2066, 0x2069, 0xfeff, 0xe0041])('refuses format character U+%s', (codePoint) => {
    for (const field of ['case_id', 'subject'] as const) {
      const err = thrown(() => parseDecisionAction({ ...BASE, [field]: `a${String.fromCodePoint(codePoint)}b` }));
      expect([err.code, err.field]).toEqual(['invalid_value', field]);
    }
  });
});
