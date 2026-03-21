import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryRevocationRegistry } from '../src/revocation.js';

describe('InMemoryRevocationRegistry', () => {
  let registry: InMemoryRevocationRegistry;

  beforeEach(() => {
    registry = new InMemoryRevocationRegistry();
  });

  it('starts empty', async () => {
    expect(registry.size).toBe(0);
    expect(await registry.listRevoked()).toEqual([]);
  });

  it('revokes a token', async () => {
    await registry.revoke('token-1', 'compromised');
    expect(await registry.isRevoked('token-1')).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('returns false for non-revoked tokens', async () => {
    expect(await registry.isRevoked('non-existent')).toBe(false);
  });

  it('stores the revocation reason', async () => {
    await registry.revoke('token-1', 'test reason');
    const list = await registry.listRevoked();
    expect(list[0]!.reason).toBe('test reason');
  });

  it('stores the revocation timestamp', async () => {
    await registry.revoke('token-1');
    const list = await registry.listRevoked();
    const ts = new Date(list[0]!.revokedAt);
    expect(ts.getTime()).toBeCloseTo(Date.now(), -3);
  });

  it('handles multiple revocations', async () => {
    await registry.revoke('token-1');
    await registry.revoke('token-2');
    await registry.revoke('token-3');

    expect(registry.size).toBe(3);
    expect(await registry.isRevoked('token-1')).toBe(true);
    expect(await registry.isRevoked('token-2')).toBe(true);
    expect(await registry.isRevoked('token-3')).toBe(true);
    expect(await registry.isRevoked('token-4')).toBe(false);
  });

  it('lists revoked tokens newest first', async () => {
    await registry.revoke('old');
    // Tiny delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await registry.revoke('new');

    const list = await registry.listRevoked();
    expect(list[0]!.tokenId).toBe('new');
    expect(list[1]!.tokenId).toBe('old');
  });

  it('clears all entries', async () => {
    await registry.revoke('token-1');
    await registry.revoke('token-2');
    registry.clear();
    expect(registry.size).toBe(0);
    expect(await registry.isRevoked('token-1')).toBe(false);
  });

  it('handles duplicate revocations', async () => {
    await registry.revoke('token-1', 'first');
    await registry.revoke('token-1', 'second');
    expect(registry.size).toBe(1);
    const list = await registry.listRevoked();
    expect(list[0]!.reason).toBe('second');
  });
});
