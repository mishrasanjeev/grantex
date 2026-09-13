import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyCodeChallenge } from '../src/lib/pkce.js';

function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('verifyCodeChallenge', () => {
  it('returns true for a valid S256 challenge', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });

  it('returns false for an invalid verifier', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge('wrong-verifier', challenge)).toBe(false);
  });

  it('rejects verifiers shorter than the RFC 7636 minimum (43 chars)', () => {
    // A 3-character verifier is brute-forceable and defeats PKCE; the
    // auth-service rejects it and so must the MCP auth server.
    const verifier = 'abc';
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge(verifier, challenge)).toBe(false);
  });

  it('returns false (does not throw) for non-string inputs', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge(12345, challenge)).toBe(false);
    expect(verifyCodeChallenge(verifier, { challenge })).toBe(false);
    expect(verifyCodeChallenge(undefined, challenge)).toBe(false);
  });

  it('handles long verifier strings', () => {
    const verifier = 'a'.repeat(128);
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });
});
