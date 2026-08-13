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

describe('vault-crypto — key and ciphertext validation', () => {
  const HEX_KEY = 'a'.repeat(64);

  it('round-trips multi-byte UTF-8 intact', async () => {
    mockConfig.vaultEncryptionKey = HEX_KEY;
    const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');

    // Decoding the cipher output in two pieces can split a multi-byte
    // character across the boundary and turn each half into U+FFFD. Joining
    // the bytes before decoding removes that dependency on cipher internals.
    for (const secret of [
      'ключ-значение',
      '鍵と値',
      '🔐🗝️ emoji secret',
      'café — naïve — €50',
      'x'.repeat(5000) + '🔐',
    ]) {
      expect(decrypt(encrypt(secret))).toBe(secret);
      expect(decrypt(encrypt(secret))).not.toContain('�');
    }
  });

  it('round-trips an empty string', async () => {
    mockConfig.vaultEncryptionKey = HEX_KEY;
    const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');

    expect(decrypt(encrypt(''))).toBe('');
  });

  it('accepts a base64-encoded key', async () => {
    mockConfig.vaultEncryptionKey = Buffer.alloc(32, 7).toString('base64');
    const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');

    expect(decrypt(encrypt('hello'))).toBe('hello');
  });

  // Buffer.from silently drops undecodable characters, so a mistyped key
  // produced a short buffer rather than an error.
  it.each([
    ['too short in hex', 'a'.repeat(32)],
    ['too long in hex', 'a'.repeat(128)],
    ['too short in base64', Buffer.alloc(16, 1).toString('base64')],
    ['not a key at all', 'definitely-not-a-key'],
  ])('rejects a key that is %s', async (_label, key) => {
    mockConfig.vaultEncryptionKey = key;
    const { encrypt } = await import('../src/lib/vault-crypto.js');

    expect(() => encrypt('hello')).toThrow(/must decode to 32 bytes/);
  });

  it('rejects ciphertext too short to hold an IV and tag', async () => {
    mockConfig.vaultEncryptionKey = HEX_KEY;
    const { decrypt } = await import('../src/lib/vault-crypto.js');

    for (const truncated of ['', Buffer.alloc(8).toString('base64'), Buffer.alloc(27).toString('base64')]) {
      expect(() => decrypt(truncated)).toThrow(/too short/);
    }
  });

  it('refuses ciphertext whose tag does not authenticate', async () => {
    mockConfig.vaultEncryptionKey = HEX_KEY;
    const { encrypt, decrypt } = await import('../src/lib/vault-crypto.js');

    const raw = Buffer.from(encrypt('sensitive'), 'base64');
    // Flip a bit in the ciphertext body, past the 12-byte IV and 16-byte tag.
    const last = raw.length - 1;
    raw[last] = (raw[last] ?? 0) ^ 0xff;

    expect(() => decrypt(raw.toString('base64'))).toThrow();
  });

  it('refuses ciphertext encrypted under a different key', async () => {
    mockConfig.vaultEncryptionKey = HEX_KEY;
    const first = await import('../src/lib/vault-crypto.js');
    const sealed = first.encrypt('sensitive');

    vi.resetModules();
    mockConfig.vaultEncryptionKey = 'b'.repeat(64);
    const second = await import('../src/lib/vault-crypto.js');

    expect(() => second.decrypt(sealed)).toThrow();
  });

  it('produces a distinct ciphertext each time', async () => {
    mockConfig.vaultEncryptionKey = HEX_KEY;
    const { encrypt } = await import('../src/lib/vault-crypto.js');

    // A reused IV under GCM is catastrophic, so the random IV must actually vary.
    const seen = new Set(Array.from({ length: 20 }, () => encrypt('same input')));
    expect(seen.size).toBe(20);
  });
});
