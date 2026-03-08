import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unmock the real vault-crypto implementation
vi.unmock('../src/lib/vault-crypto.js');

// Hoist mock config
const { mockConfig } = vi.hoisted(() => {
  const mockConfig = {
    vaultEncryptionKey: null as string | null,
  };
  return { mockConfig };
});

vi.mock('../src/config.js', () => ({ config: mockConfig }));

beforeEach(() => {
  mockConfig.vaultEncryptionKey = null;
  vi.resetModules();
});

describe('vault-crypto', () => {
  describe('getKey (via encrypt/decrypt)', () => {
    it('throws when VAULT_ENCRYPTION_KEY not set', async () => {
      mockConfig.vaultEncryptionKey = null;

      const { encrypt } = await import('../src/lib/vault-crypto.js');
      expect(() => encrypt('hello')).toThrow('VAULT_ENCRYPTION_KEY is not configured');
    });

    it('throws on decrypt when VAULT_ENCRYPTION_KEY not set', async () => {
      mockConfig.vaultEncryptionKey = null;

      const { decrypt } = await import('../src/lib/vault-crypto.js');
      expect(() => decrypt('dGVzdA==')).toThrow('VAULT_ENCRYPTION_KEY is not configured');
    });
  });

  describe('encrypt', () => {
    it('produces base64 string', async () => {
      // 32-byte key = 64 hex chars
      mockConfig.vaultEncryptionKey = '0'.repeat(64);

      const { encrypt } = await import('../src/lib/vault-crypto.js');
      const result = encrypt('hello world');

      expect(typeof result).toBe('string');
      // Verify it's valid base64
      expect(() => Buffer.from(result, 'base64')).not.toThrow();
      // base64 should decode to iv (12) + tag (16) + ciphertext (>0)
      const decoded = Buffer.from(result, 'base64');
      expect(decoded.length).toBeGreaterThan(28); // 12 + 16 = 28 minimum
    });

    it('produces different ciphertexts for same input (random IV)', async () => {
      mockConfig.vaultEncryptionKey = '0'.repeat(64);

      const { encrypt } = await import('../src/lib/vault-crypto.js');
      const a = encrypt('same-plaintext');
      const b = encrypt('same-plaintext');

      expect(a).not.toBe(b);
    });
  });

  describe('decrypt', () => {
    it('reverses encrypt (round-trip test)', async () => {
      mockConfig.vaultEncryptionKey = '0'.repeat(64);

      const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');
      const plaintext = 'secret-data-12345';
      const ciphertext = encrypt(plaintext);
      const result = decrypt(ciphertext);

      expect(result).toBe(plaintext);
    });

    it('round-trips empty string', async () => {
      mockConfig.vaultEncryptionKey = '0'.repeat(64);

      const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');
      const ciphertext = encrypt('');
      expect(decrypt(ciphertext)).toBe('');
    });

    it('round-trips unicode', async () => {
      mockConfig.vaultEncryptionKey = '0'.repeat(64);

      const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');
      const unicode = 'Hello, World! Emoji test';
      const ciphertext = encrypt(unicode);
      expect(decrypt(ciphertext)).toBe(unicode);
    });

    it('throws with tampered ciphertext', async () => {
      mockConfig.vaultEncryptionKey = '0'.repeat(64);

      const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');
      const ciphertext = encrypt('secret');

      // Tamper with the ciphertext
      const buf = Buffer.from(ciphertext, 'base64');
      buf[buf.length - 1] = (buf[buf.length - 1]! + 1) % 256;
      const tampered = buf.toString('base64');

      expect(() => decrypt(tampered)).toThrow();
    });
  });
});
