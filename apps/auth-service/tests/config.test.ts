import { describe, expect, it } from 'vitest';
import { parseIntegerSetting, parsePolicyBackend } from '../src/config.js';

describe('configuration parsing', () => {
  it('accepts bounded integer settings', () => {
    expect(parseIntegerSetting('PORT', '3001', 1, 65_535)).toBe(3001);
    expect(parseIntegerSetting('LIMIT', '1', 1, 100)).toBe(1);
  });

  it('rejects partial, non-finite, and out-of-range integers', () => {
    expect(() => parseIntegerSetting('PORT', '3001junk', 1, 65_535)).toThrow(/PORT/);
    expect(() => parseIntegerSetting('PORT', 'NaN', 1, 65_535)).toThrow(/PORT/);
    expect(() => parseIntegerSetting('PORT', '0', 1, 65_535)).toThrow(/PORT/);
    expect(() => parseIntegerSetting('PORT', '65536', 1, 65_535)).toThrow(/PORT/);
  });

  it('rejects unknown policy backends instead of silently using builtin', () => {
    expect(parsePolicyBackend('opa')).toBe('opa');
    expect(() => parsePolicyBackend('open-policy-agent')).toThrow(/POLICY_BACKEND/);
  });
});
