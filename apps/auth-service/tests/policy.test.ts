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

  // An allow policy may only match when it covers everything being requested;
  // otherwise it would grant scopes it never listed.
  it('skips an allow policy when requested scopes are not a subset of its scopes', () => {
    // Policy only covers 'read'; request includes 'write' too → no match
    const policy: PolicyRow = { ...BASE, effect: 'allow', scopes: ['read'] };
    expect(evaluatePolicies([policy], CTX)).toBeNull();
  });

  it('matches an allow policy when requested scopes are a subset of its scopes', () => {
    const policy: PolicyRow = { ...BASE, effect: 'allow', scopes: ['read', 'write', 'admin'] };
    expect(evaluatePolicies([policy], CTX)).toBe('allow');
  });

  it('matches an allow policy when requested scopes exactly equal its scopes', () => {
    const policy: PolicyRow = { ...BASE, effect: 'allow', scopes: ['read', 'write'] };
    expect(evaluatePolicies([policy], CTX)).toBe('allow');
  });

  // A deny policy matches on overlap. Requiring containment let a caller slip
  // past a deny rule by requesting an unrelated scope alongside the blocked one.
  it('matches a deny policy when only one requested scope is denied', () => {
    const policy: PolicyRow = { ...BASE, effect: 'deny', scopes: ['read'] };
    expect(evaluatePolicies([policy], CTX)).toBe('deny');
  });

  it('does not let an extra unrelated scope bypass a deny policy', () => {
    const policy: PolicyRow = { ...BASE, effect: 'deny', scopes: ['payments:transfer'] };

    expect(
      evaluatePolicies([policy], { ...CTX, scopes: ['payments:transfer'] }),
    ).toBe('deny');
    expect(
      evaluatePolicies([policy], { ...CTX, scopes: ['calendar:read', 'payments:transfer'] }),
    ).toBe('deny');
    expect(
      evaluatePolicies([policy], {
        ...CTX,
        scopes: ['calendar:read', 'files:read', 'payments:transfer', 'profile:read'],
      }),
    ).toBe('deny');
  });

  it('skips a deny policy when no requested scope is denied', () => {
    const policy: PolicyRow = { ...BASE, effect: 'deny', scopes: ['payments:transfer'] };
    expect(
      evaluatePolicies([policy], { ...CTX, scopes: ['calendar:read', 'files:read'] }),
    ).toBeNull();
  });

  it('matches a deny policy when requested scopes exactly equal its scopes', () => {
    const policy: PolicyRow = { ...BASE, effect: 'deny', scopes: ['read', 'write'] };
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
