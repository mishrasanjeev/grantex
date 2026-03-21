import { describe, it, expect } from 'vitest';
import { generateKeyPair, derivePublicKey, signJWT, verifyJWT, importPublicKeyFromDID } from '../src/crypto.js';

describe('Crypto utilities', () => {
  describe('generateKeyPair', () => {
    it('produces a 32-byte private key', () => {
      const kp = generateKeyPair();
      expect(kp.privateKey).toBeInstanceOf(Uint8Array);
      expect(kp.privateKey.length).toBe(32);
    });

    it('produces a 32-byte public key', () => {
      const kp = generateKeyPair();
      expect(kp.publicKey).toBeInstanceOf(Uint8Array);
      expect(kp.publicKey.length).toBe(32);
    });

    it('produces a valid DID', () => {
      const kp = generateKeyPair();
      expect(kp.did).toMatch(/^did:key:z6Mk/);
    });

    it('generates unique key pairs', () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      expect(kp1.did).not.toBe(kp2.did);
    });
  });

  describe('derivePublicKey', () => {
    it('derives the same public key as generateKeyPair', () => {
      const kp = generateKeyPair();
      const derived = derivePublicKey(kp.privateKey);
      expect(derived.publicKey).toEqual(kp.publicKey);
      expect(derived.did).toBe(kp.did);
    });
  });

  describe('JWT signing and verification', () => {
    it('signs and verifies a JWT', async () => {
      const kp = generateKeyPair();
      const payload = { foo: 'bar', num: 42 };
      const token = await signJWT(payload, kp.privateKey);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);

      const decoded = await verifyJWT(token, kp.publicKey);
      expect(decoded['foo']).toBe('bar');
      expect(decoded['num']).toBe(42);
    });

    it('rejects a token signed with a different key', async () => {
      const kp1 = generateKeyPair();
      const kp2 = generateKeyPair();
      const token = await signJWT({ test: true }, kp1.privateKey);

      await expect(verifyJWT(token, kp2.publicKey)).rejects.toThrow();
    });

    it('rejects a tampered token', async () => {
      const kp = generateKeyPair();
      const token = await signJWT({ test: true }, kp.privateKey);

      // Tamper with the payload section
      const parts = token.split('.');
      parts[1] = parts[1]!.slice(0, -1) + (parts[1]!.endsWith('A') ? 'B' : 'A');
      const tampered = parts.join('.');

      await expect(verifyJWT(tampered, kp.publicKey)).rejects.toThrow();
    });
  });

  describe('importPublicKeyFromDID', () => {
    it('imports a key from a valid DID', async () => {
      const kp = generateKeyPair();
      const key = await importPublicKeyFromDID(kp.did);
      expect(key).toBeDefined();
    });

    it('rejects an invalid DID', async () => {
      await expect(importPublicKeyFromDID('did:web:example.com')).rejects.toThrow();
    });
  });
});
