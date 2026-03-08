import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generatePkce } from '../src/pkce.js';

describe('generatePkce', () => {
  it('returns codeVerifier, codeChallenge, and codeChallengeMethod S256', () => {
    const result = generatePkce();

    expect(result).toHaveProperty('codeVerifier');
    expect(result).toHaveProperty('codeChallenge');
    expect(result.codeChallengeMethod).toBe('S256');
    expect(typeof result.codeVerifier).toBe('string');
    expect(typeof result.codeChallenge).toBe('string');
    expect(result.codeVerifier.length).toBeGreaterThan(0);
    expect(result.codeChallenge.length).toBeGreaterThan(0);
  });

  it('produces a valid S256 hash of the verifier', () => {
    const { codeVerifier, codeChallenge } = generatePkce();

    const expectedChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    expect(codeChallenge).toBe(expectedChallenge);
  });

  it('generates unique verifiers on each call', () => {
    const a = generatePkce();
    const b = generatePkce();

    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});
