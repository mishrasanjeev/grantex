import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real implementation
vi.unmock('../src/lib/domains.js');

// Hoist mock for dns/promises
const { mockResolve } = vi.hoisted(() => {
  const mockResolve = vi.fn();
  return { mockResolve };
});

vi.mock('node:dns/promises', () => ({
  resolve: mockResolve,
}));

import { verifyDomainDns } from '../src/lib/domains.js';

beforeEach(() => {
  mockResolve.mockReset();
});

describe('verifyDomainDns', () => {
  it('returns true when DNS TXT record matches token', async () => {
    mockResolve.mockResolvedValueOnce([['grantex-verify-abc123']]);

    const result = await verifyDomainDns('example.com', 'grantex-verify-abc123');

    expect(result).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith('_grantex.example.com', 'TXT');
  });

  it('returns true when DNS TXT record is split across chunks', async () => {
    // DNS TXT records can be returned as arrays of chunks
    mockResolve.mockResolvedValueOnce([['grantex-verify-', 'abc123']]);

    const result = await verifyDomainDns('example.com', 'grantex-verify-abc123');

    expect(result).toBe(true);
  });

  it('returns false when no matching record', async () => {
    mockResolve.mockResolvedValueOnce([['some-other-record']]);

    const result = await verifyDomainDns('example.com', 'grantex-verify-abc123');

    expect(result).toBe(false);
  });

  it('returns false when DNS lookup fails', async () => {
    mockResolve.mockRejectedValueOnce(new Error('ENOTFOUND'));

    const result = await verifyDomainDns('nonexistent.example.com', 'token');

    expect(result).toBe(false);
  });

  it('returns false when no TXT records at all', async () => {
    mockResolve.mockResolvedValueOnce([]);

    const result = await verifyDomainDns('example.com', 'token');

    expect(result).toBe(false);
  });

  it('handles non-array record values via String() coercion', async () => {
    // When record is not an array, code does String(record)
    mockResolve.mockResolvedValueOnce(['my-token-value']);

    const result = await verifyDomainDns('example.com', 'my-token-value');

    expect(result).toBe(true);
  });
});
