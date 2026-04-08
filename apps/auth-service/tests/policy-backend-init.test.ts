import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real implementation
vi.unmock('../src/lib/policy-backend.js');

// Hoist mock config and backend constructors
const { mockConfig, MockBuiltinBackend, MockOpaBackend, MockCedarBackend } = vi.hoisted(() => {
  const mockConfig = {
    policyBackend: 'builtin' as string,
    opaUrl: null as string | null,
    opaFallbackToBuiltin: true,
    cedarUrl: null as string | null,
    cedarFallbackToBuiltin: true,
  };
  const MockBuiltinBackend = vi.fn(function (this: Record<string, unknown>) { this.evaluate = vi.fn(); });
  const MockOpaBackend = vi.fn(function (this: Record<string, unknown>) { this.evaluate = vi.fn(); });
  const MockCedarBackend = vi.fn(function (this: Record<string, unknown>) { this.evaluate = vi.fn(); });
  return { mockConfig, MockBuiltinBackend, MockOpaBackend, MockCedarBackend };
});

vi.mock('../src/config.js', () => ({ config: mockConfig }));
vi.mock('../src/lib/backends/builtin.js', () => ({ BuiltinBackend: MockBuiltinBackend }));
vi.mock('../src/lib/backends/opa.js', () => ({ OpaBackend: MockOpaBackend }));
vi.mock('../src/lib/backends/cedar.js', () => ({ CedarBackend: MockCedarBackend }));

import { getPolicyBackend, resetPolicyBackend } from '../src/lib/policy-backend.js';

beforeEach(() => {
  mockConfig.policyBackend = 'builtin';
  mockConfig.opaUrl = null;
  mockConfig.cedarUrl = null;
  MockBuiltinBackend.mockClear();
  MockOpaBackend.mockClear();
  MockCedarBackend.mockClear();
  resetPolicyBackend();
});

describe('getPolicyBackend', () => {
  it('returns Builtin backend by default', () => {
    mockConfig.policyBackend = 'builtin';

    const backend = getPolicyBackend();

    expect(backend).toBeDefined();
    expect(MockBuiltinBackend).toHaveBeenCalledOnce();
    expect(MockOpaBackend).not.toHaveBeenCalled();
    expect(MockCedarBackend).not.toHaveBeenCalled();
  });

  it('returns OPA backend when config.policyBackend is opa', () => {
    mockConfig.policyBackend = 'opa';
    mockConfig.opaUrl = 'http://opa:8181';

    const backend = getPolicyBackend();

    expect(backend).toBeDefined();
    expect(MockOpaBackend).toHaveBeenCalledWith('http://opa:8181', true);
    expect(MockBuiltinBackend).not.toHaveBeenCalled();
  });

  it('returns Cedar backend when config.policyBackend is cedar', () => {
    mockConfig.policyBackend = 'cedar';
    mockConfig.cedarUrl = 'http://cedar:8080';
    mockConfig.cedarFallbackToBuiltin = false;

    const backend = getPolicyBackend();

    expect(backend).toBeDefined();
    expect(MockCedarBackend).toHaveBeenCalledWith('http://cedar:8080', false);
    expect(MockBuiltinBackend).not.toHaveBeenCalled();
  });

  it('returns same instance on subsequent calls (singleton)', () => {
    mockConfig.policyBackend = 'builtin';

    const first = getPolicyBackend();
    const second = getPolicyBackend();

    expect(first).toBe(second);
    expect(MockBuiltinBackend).toHaveBeenCalledTimes(1);
  });
});

describe('resetPolicyBackend', () => {
  it('clears singleton so next call creates new instance', () => {
    mockConfig.policyBackend = 'builtin';

    const first = getPolicyBackend();
    resetPolicyBackend();
    const second = getPolicyBackend();

    expect(first).not.toBe(second);
    expect(MockBuiltinBackend).toHaveBeenCalledTimes(2);
  });
});
