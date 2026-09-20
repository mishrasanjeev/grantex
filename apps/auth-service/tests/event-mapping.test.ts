import { describe, expect, it } from 'vitest';
import {
  RuleValidationError,
  eventTypeMatches,
  parseRuleInput,
  readEventPath,
  ruleMatchesEvent,
  targetValues,
  type MappingRule,
} from '../src/lib/event-bridge/mapping.js';
import type { NormalizedEvent } from '../src/lib/event-bridge/normalize.js';

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    sourceId: 'evsrc_01',
    sourceKind: 'webhook',
    developerId: 'dev_01',
    eventId: 'evt_1',
    type: 'business.dissolved',
    subject: { business_ref: 'gb:00000001', case_id: 'case_0001' },
    data: { status: 'dissolved', filing: { code: 'DISS', parties: ['p1', 'p2'] } },
    occurredAt: null,
    ...overrides,
  };
}

function rule(overrides: Partial<MappingRule> = {}): MappingRule {
  return {
    id: 'evmap_01',
    developerId: 'dev_01',
    name: 'dissolution revokes',
    sourceId: null,
    eventType: 'business.dissolved',
    conditions: [],
    target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
    action: 'revoke',
    mode: 'enforce',
    status: 'active',
    ...overrides,
  };
}

describe('reading paths out of an event', () => {
  it('reads the type, subject and data, including nested members and array elements', () => {
    expect(readEventPath(event(), 'type')).toBe('business.dissolved');
    expect(readEventPath(event(), 'subject.business_ref')).toBe('gb:00000001');
    expect(readEventPath(event(), 'data.filing.code')).toBe('DISS');
    expect(readEventPath(event(), 'data.filing.parties.1')).toBe('p2');
  });

  it('returns undefined for anything absent instead of throwing', () => {
    expect(readEventPath(event(), 'data.missing')).toBeUndefined();
    expect(readEventPath(event(), 'data.status.deeper')).toBeUndefined();
    expect(readEventPath(event(), 'data.filing.parties.9')).toBeUndefined();
    // Inherited members are not event data.
    expect(readEventPath(event(), 'data.constructor')).toBeUndefined();
    expect(readEventPath(event(), 'subject.__proto__')).toBeUndefined();
  });
});

describe('event type matching', () => {
  it('matches exactly, or by prefix when the pattern ends in *', () => {
    expect(eventTypeMatches('business.dissolved', 'business.dissolved')).toBe(true);
    expect(eventTypeMatches('business.dissolved', 'business.dissolved.v2')).toBe(false);
    expect(eventTypeMatches('business.*', 'business.dissolved')).toBe(true);
    expect(eventTypeMatches('*', 'anything')).toBe(true);
    expect(eventTypeMatches('business.*', 'businessx.dissolved')).toBe(false);
  });
});

describe('rule matching', () => {
  it('applies only to active rules, the named source, and events whose conditions all hold', () => {
    expect(ruleMatchesEvent(rule(), event())).toBe(true);
    expect(ruleMatchesEvent(rule({ status: 'disabled' }), event())).toBe(false);
    expect(ruleMatchesEvent(rule({ sourceId: 'evsrc_other' }), event())).toBe(false);
    expect(ruleMatchesEvent(rule({ sourceId: 'evsrc_01' }), event())).toBe(true);
    expect(ruleMatchesEvent(rule({ eventType: 'session.*' }), event())).toBe(false);

    const conditioned = rule({ conditions: [{ path: 'data.status', equals: 'dissolved' }] });
    expect(ruleMatchesEvent(conditioned, event())).toBe(true);
    expect(ruleMatchesEvent(conditioned, event({ data: { status: 'active' } }))).toBe(false);
    expect(ruleMatchesEvent(conditioned, event({ data: {} }))).toBe(false);

    const inList = rule({ conditions: [{ path: 'data.filing.code', in: ['DISS', 'LIQ'] }] });
    expect(ruleMatchesEvent(inList, event())).toBe(true);
    expect(ruleMatchesEvent(inList, event({ data: { filing: { code: 'OTHER' } } }))).toBe(false);

    const exists = rule({ conditions: [{ path: 'subject.case_id', exists: true }] });
    expect(ruleMatchesEvent(exists, event())).toBe(true);
    expect(ruleMatchesEvent(exists, event({ subject: {} }))).toBe(false);
    expect(ruleMatchesEvent(rule({ conditions: [{ path: 'subject.case_id', exists: false }] }), event())).toBe(false);

    const all = rule({ conditions: [{ path: 'data.status', equals: 'dissolved' }, { path: 'subject.case_id', equals: 'other' }] });
    expect(ruleMatchesEvent(all, event())).toBe(false);
  });

  it('never matches a value of another JSON type by coercion', () => {
    const numeric = rule({ conditions: [{ path: 'data.count', equals: 1 }] });
    expect(ruleMatchesEvent(numeric, event({ data: { count: 1 } }))).toBe(true);
    expect(ruleMatchesEvent(numeric, event({ data: { count: '1' } }))).toBe(false);
    expect(ruleMatchesEvent(numeric, event({ data: { count: true } }))).toBe(false);
    const object = rule({ conditions: [{ path: 'data.filing', equals: 'DISS' }] });
    expect(ruleMatchesEvent(object, event())).toBe(false);
  });
});

describe('target values', () => {
  it('reads one identifier or a list, and refuses anything else', () => {
    expect(targetValues(rule(), event())).toEqual(['gb:00000001']);
    expect(targetValues(rule({ target: { by: 'grant_id', path: 'data.grants' } }),
      event({ data: { grants: ['grnt_1', 'grnt_2', 'grnt_1'] } }))).toEqual(['grnt_1', 'grnt_2']);
    expect(targetValues(rule(), event({ subject: {} }))).toBeNull();
    expect(targetValues(rule(), event({ subject: { business_ref: 42 } }))).toBeNull();
    expect(targetValues(rule(), event({ subject: { business_ref: { id: 'x' } } }))).toBeNull();
    expect(targetValues(rule({ target: { by: 'grant_id', path: 'data.grants' } }),
      event({ data: { grants: [] } }))).toBeNull();
    expect(targetValues(rule({ target: { by: 'grant_id', path: 'data.grants' } }),
      event({ data: { grants: Array.from({ length: 51 }, (_, i) => `grnt_${i}`) } }))).toBeNull();
  });
});

describe('rule validation', () => {
  const valid = {
    name: 'dissolution revokes',
    eventType: 'business.dissolved',
    conditions: [{ path: 'data.status', equals: 'dissolved' }],
    target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
    action: 'revoke',
  };

  it('accepts a complete rule and fills in defaults', () => {
    expect(parseRuleInput(valid)).toEqual({
      name: 'dissolution revokes',
      sourceId: null,
      eventType: 'business.dissolved',
      conditions: [{ path: 'data.status', equals: 'dissolved' }],
      target: { by: 'subject_ref', path: 'subject.business_ref', kind: 'business_ref' },
      action: 'revoke',
      mode: 'enforce',
      status: 'active',
    });
  });

  it('refuses unknown fields, bad paths, ambiguous conditions and bad targets', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...valid, developerId: 'dev_other' }, 'body'],
      [{ ...valid, name: '' }, 'name'],
      [{ ...valid, eventType: 'a b\nc' }, 'eventType'],
      [{ ...valid, action: 'delete' }, 'action'],
      [{ ...valid, mode: 'dry-run' }, 'mode'],
      [{ ...valid, status: 'paused' }, 'status'],
      [{ ...valid, conditions: [{ path: 'grant.id', equals: 'x' }] }, 'conditions'],
      [{ ...valid, conditions: [{ path: 'data.status', equals: 'x', exists: true }] }, 'conditions'],
      [{ ...valid, conditions: [{ path: 'data.status' }] }, 'conditions'],
      [{ ...valid, conditions: [{ path: 'data.status', equals: { deep: true } }] }, 'conditions'],
      [{ ...valid, conditions: [{ path: 'data.status', in: [] }] }, 'conditions'],
      [{ ...valid, conditions: Array.from({ length: 11 }, () => ({ path: 'data.status', exists: true })) }, 'conditions'],
      [{ ...valid, target: { by: 'subject_ref', path: 'subject.business_ref' } }, 'target'],
      [{ ...valid, target: { by: 'grant_id', path: 'subject.id', kind: 'business_ref' } }, 'target'],
      [{ ...valid, target: { by: 'developer_id', path: 'subject.id' } }, 'target'],
      [{ ...valid, target: { by: 'grant_id', path: 'evil.path' } }, 'target'],
      [{ ...valid, sourceId: 42 }, 'sourceId'],
    ];
    for (const [body, field] of cases) {
      try {
        parseRuleInput(body);
        throw new Error(`expected ${JSON.stringify(body)} to be refused`);
      } catch (err) {
        expect(err).toBeInstanceOf(RuleValidationError);
        expect(Object.keys((err as RuleValidationError).fields)).toContain(field);
      }
    }
  });

  it('patches an existing rule member by member', () => {
    const existing: MappingRule = { id: 'evmap_01', developerId: 'dev_01', ...parseRuleInput(valid) };
    expect(parseRuleInput({ mode: 'observe' }, existing)).toMatchObject({
      name: 'dissolution revokes',
      action: 'revoke',
      mode: 'observe',
      conditions: [{ path: 'data.status', equals: 'dissolved' }],
    });
    expect(parseRuleInput({ status: 'disabled' }, existing).status).toBe('disabled');
    expect(parseRuleInput({ conditions: [] }, existing).conditions).toEqual([]);
    expect(() => parseRuleInput({ action: 'nonsense' }, existing)).toThrow(RuleValidationError);
  });
});
