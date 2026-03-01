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

  it('handles short verifier strings', () => {
    const verifier = 'abc';
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });

  it('handles long verifier strings', () => {
    const verifier = 'a'.repeat(128);
    const challenge = computeS256Challenge(verifier);
    expect(verifyCodeChallenge(verifier, challenge)).toBe(true);
  });
});
