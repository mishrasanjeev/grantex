import { describe, it, expect } from 'vitest';
import { evaluatePolicies, type PolicyRow } from '../src/lib/policy.js';

const BASE: PolicyRow = {
  id: 'pol_1',
  effect: 'deny',
  priority: 0,
  agent_id: null,
  principal_id: null,
  scopes: null,
  time_of_day_start: null,
  time_of_day_end: null,
};

const CTX = {
  agentId: 'ag_01',
  principalId: 'user_01',
  scopes: ['read', 'write'],
};

describe('evaluatePolicies', () => {
  it('returns null when no policies exist', () => {
    expect(evaluatePolicies([], CTX)).toBeNull();
  });

  it('returns deny when an unconditional deny policy matches', () => {
    expect(evaluatePolicies([BASE], CTX)).toBe('deny');
  });

  it('returns allow when an unconditional allow policy matches', () => {
    expect(evaluatePolicies([{ ...BASE, effect: 'allow' }], CTX)).toBe('allow');
  });

  it('deny takes priority over allow when deny has higher priority', () => {
    const policies: PolicyRow[] = [
      { ...BASE, effect: 'deny', priority: 10 },
      { ...BASE, effect: 'allow', priority: 5 },
    ];
    expect(evaluatePolicies(policies, CTX)).toBe('deny');
  });

  it('skips policy when agent_id does not match', () => {
    const policy: PolicyRow = { ...BASE, agent_id: 'ag_other' };
    expect(evaluatePolicies([policy], CTX)).toBeNull();
  });

  it('matches when agent_id matches', () => {
    const policy: PolicyRow = { ...BASE, agent_id: 'ag_01' };
    expect(evaluatePolicies([policy], CTX)).toBe('deny');
  });

  it('skips policy when principal_id does not match', () => {
    const policy: PolicyRow = { ...BASE, principal_id: 'user_other' };
    expect(evaluatePolicies([policy], CTX)).toBeNull();
  });

  it('skips when requested scopes are not a subset of policy scopes', () => {
    // Policy only covers 'read'; request includes 'write' too → no match
    const policy: PolicyRow = { ...BASE, scopes: ['read'] };
    expect(evaluatePolicies([policy], CTX)).toBeNull();
  });

  it('matches when requested scopes are a subset of policy scopes', () => {
    const policy: PolicyRow = { ...BASE, scopes: ['read', 'write', 'admin'] };
    expect(evaluatePolicies([policy], CTX)).toBe('deny');
  });

  it('matches when requested scopes exactly equal policy scopes', () => {
    const policy: PolicyRow = { ...BASE, scopes: ['read', 'write'] };
    expect(evaluatePolicies([policy], CTX)).toBe('deny');
  });

  it('matches within time window', () => {
    const policy: PolicyRow = {
      ...BASE,
      time_of_day_start: '09:00',
      time_of_day_end: '17:00',
    };
    expect(
      evaluatePolicies([policy], { ...CTX, nowUtcHHMM: '12:00' }),
    ).toBe('deny');
  });

  it('does not match outside time window', () => {
    const policy: PolicyRow = {
      ...BASE,
      time_of_day_start: '09:00',
      time_of_day_end: '17:00',
    };
    expect(
      evaluatePolicies([policy], { ...CTX, nowUtcHHMM: '20:00' }),
    ).toBeNull();
  });

  it('handles midnight-wrapping time window', () => {
    const policy: PolicyRow = {
      ...BASE,
      time_of_day_start: '22:00',
      time_of_day_end: '06:00',
    };
    expect(evaluatePolicies([policy], { ...CTX, nowUtcHHMM: '23:30' })).toBe('deny');
    expect(evaluatePolicies([policy], { ...CTX, nowUtcHHMM: '05:00' })).toBe('deny');
    expect(evaluatePolicies([policy], { ...CTX, nowUtcHHMM: '10:00' })).toBeNull();
  });
});
