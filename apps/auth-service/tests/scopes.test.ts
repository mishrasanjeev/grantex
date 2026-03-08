import { describe, it, expect } from 'vitest';
import { describeScope, SCOPE_DESCRIPTIONS } from '../src/lib/scopes.js';

describe('describeScope', () => {
  it('returns description for known scopes', () => {
    expect(describeScope('calendar:read')).toBe('Read your calendar events');
    expect(describeScope('email:send')).toBe('Send emails on your behalf');
  });

  it('returns description for payments:initiate:max_N scopes', () => {
    expect(describeScope('payments:initiate:max_500')).toBe(
      "Initiate payments up to 500 in your account's base currency",
    );
  });

  it('returns the raw scope string for unknown scopes', () => {
    expect(describeScope('custom:thing')).toBe('custom:thing');
    expect(describeScope('unknown')).toBe('unknown');
  });
});
