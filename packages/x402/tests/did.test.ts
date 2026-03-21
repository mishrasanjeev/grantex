import { describe, it, expect } from 'vitest';
import { publicKeyToDID, didToPublicKey, isValidDID, base58btcEncode, base58btcDecode } from '../src/did.js';
import { generateKeyPair } from '../src/crypto.js';

describe('DID utilities', () => {
  describe('base58btc encoding', () => {
    it('round-trips arbitrary bytes', () => {
      const data = new Uint8Array([0, 0, 1, 2, 3, 255, 128, 64]);
      const encoded = base58btcEncode(data);
      const decoded = base58btcDecode(encoded);
      expect(decoded).toEqual(data);
    });

    it('handles all zeros', () => {
      const data = new Uint8Array([0, 0, 0]);
      const encoded = base58btcEncode(data);
      expect(encoded).toBe('111');
      expect(base58btcDecode(encoded)).toEqual(data);
    });

    it('rejects invalid characters', () => {
      expect(() => base58btcDecode('0OIl')).toThrow('Invalid base58 character');
    });
  });

  describe('publicKeyToDID', () => {
    it('produces a valid did:key string', () => {
      const kp = generateKeyPair();
      const did = publicKeyToDID(kp.publicKey);
      expect(did).toMatch(/^did:key:z6Mk/);
    });

    it('rejects non-32-byte keys', () => {
      expect(() => publicKeyToDID(new Uint8Array(16))).toThrow('32 bytes');
    });
  });

  describe('didToPublicKey', () => {
    it('round-trips through publicKeyToDID', () => {
      const kp = generateKeyPair();
      const did = publicKeyToDID(kp.publicKey);
      const recovered = didToPublicKey(did);
      expect(recovered).toEqual(kp.publicKey);
    });

    it('rejects non-did:key DIDs', () => {
      expect(() => didToPublicKey('did:web:example.com')).toThrow('Only did:key is supported');
    });

    it('rejects invalid base58', () => {
      expect(() => didToPublicKey('did:key:z0000')).toThrow();
    });
  });

  describe('isValidDID', () => {
    it('returns true for valid Ed25519 did:key', () => {
      const kp = generateKeyPair();
      expect(isValidDID(kp.did)).toBe(true);
    });

    it('returns false for did:web', () => {
      expect(isValidDID('did:web:example.com')).toBe(false);
    });

    it('returns false for garbage', () => {
      expect(isValidDID('not-a-did')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isValidDID('')).toBe(false);
    });
  });
});
