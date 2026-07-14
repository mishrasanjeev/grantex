import { describe, expect, it } from 'vitest';
import {
  parseIntegerSetting,
  parsePolicyBackend,
  parseTrustProxySetting,
} from '../src/config.js';

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

  it('parses only explicit trusted proxy chains', () => {
    expect(parseTrustProxySetting(undefined)).toBe(false);
    expect(parseTrustProxySetting('false')).toBe(false);
    expect(parseTrustProxySetting(' false ')).toBe(false);
    expect(parseTrustProxySetting('1')).toBe(1);
    expect(parseTrustProxySetting('16')).toBe(16);
    expect(parseTrustProxySetting('127.0.0.1/32, 10.0.0.0/8')).toEqual([
      '127.0.0.1/32',
      '10.0.0.0/8',
    ]);
    expect(parseTrustProxySetting('127.0.0.1, ::1, 2001:db8::/32')).toEqual([
      '127.0.0.1', '::1', '2001:db8::/32',
    ]);

  });

  it('rejects proxy aliases, blanket ranges, invalid addresses, and invalid hop counts', () => {
    expect(() => parseTrustProxySetting('true')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('*')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('0.0.0.0/0')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('0')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('::/0')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('17')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('uniquelocal')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('loopback')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('proxy.internal')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('10.0.0.0/33')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('fc00::/129')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxySetting('127.0.0.1/32/1')).toThrow(/TRUST_PROXY/);
  });

  it('rejects unknown policy backends instead of silently using builtin', () => {
    expect(parsePolicyBackend('opa')).toBe('opa');
    expect(() => parsePolicyBackend('open-policy-agent')).toThrow(/POLICY_BACKEND/);
  });
});
