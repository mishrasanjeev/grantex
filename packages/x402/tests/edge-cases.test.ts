import { describe, it, expect, beforeEach } from 'vitest';
import { issueGDT } from '../src/gdt.js';
import { verifyGDT } from '../src/verify.js';
import { generateKeyPair } from '../src/crypto.js';
import { publicKeyToDID, base58btcEncode, base58btcDecode } from '../src/did.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';
import type { IssueGDTParams } from '../src/types.js';

describe('Edge cases', () => {
  let principal: ReturnType<typeof generateKeyPair>;
  let agent: ReturnType<typeof generateKeyPair>;
  let baseParams: IssueGDTParams;

  beforeEach(() => {
    setRevocationRegistry(new InMemoryRevocationRegistry());
    setAuditLog(new InMemoryAuditLog());
    principal = generateKeyPair();
    agent = generateKeyPair();
    baseParams = {
      agentDID: agent.did,
      scope: ['weather:read'],
      spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
      expiry: '24h',
      signingKey: principal.privateKey,
    };
  });

  // ── Scope matching edge cases ─────────────────────────────────────

  describe('scope matching edge cases', () => {
    it('is case-sensitive', async () => {
      const token = await issueGDT({ ...baseParams, scope: ['weather:read'] });
      const result = await verifyGDT(token, {
        resource: 'Weather:Read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
    });

    it('does not match partial scope names', async () => {
      const token = await issueGDT({ ...baseParams, scope: ['weather:read'] });
      const result = await verifyGDT(token, {
        resource: 'weath:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
    });

    it('wildcard weather:* does not match different resource', async () => {
      const token = await issueGDT({ ...baseParams, scope: ['weather:*'] });
      const result = await verifyGDT(token, {
        resource: 'weatherinfo:read',
        amount: 0.001,
        currency: 'USDC',
      });
      // "weatherinfo:read" should NOT match "weather:*" because
      // the prefix is "weather:" and "weatherinfo:" doesn't start with "weather:"
      expect(result.valid).toBe(false);
    });

    it('handles scopes with multiple colons', async () => {
      const token = await issueGDT({ ...baseParams, scope: ['api:weather:read'] });
      const result = await verifyGDT(token, {
        resource: 'api:weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(true);
    });
  });

  // ── Spend limit edge cases ────────────────────────────────────────

  describe('spend limit edge cases', () => {
    it('handles very small amounts (0.000001)', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.000001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(true);
      expect(result.remainingLimit).toBeCloseTo(9.999999);
    });

    it('handles amount exactly at limit boundary', async () => {
      const token = await issueGDT({
        ...baseParams,
        spendLimit: { amount: 0.001, currency: 'USDC', period: '24h' },
      });

      // Exactly at limit — should pass
      const r1 = await verifyGDT(token, { resource: 'weather:read', amount: 0.001, currency: 'USDC' });
      expect(r1.valid).toBe(true);
      expect(r1.remainingLimit).toBe(0);

      // Over by smallest increment — should fail
      const r2 = await verifyGDT(token, { resource: 'weather:read', amount: 0.0011, currency: 'USDC' });
      expect(r2.valid).toBe(false);
    });

    it('handles negative request amount gracefully', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: -1,
        currency: 'USDC',
      });
      // Negative amount is technically <= limit, so it passes scope/limit checks
      expect(result.valid).toBe(true);
    });
  });

  // ── JWT security edge cases ───────────────────────────────────────

  describe('JWT security edge cases', () => {
    it('rejects alg:none attack', async () => {
      const token = await issueGDT(baseParams);
      const parts = token.split('.');

      // Replace header with alg:none
      const header = { alg: 'none', typ: 'JWT' };
      parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
      // Remove signature
      parts[2] = '';
      const tampered = parts.join('.');

      const result = await verifyGDT(tampered, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects token with issuer DID pointing to different key', async () => {
      const attacker = generateKeyPair();
      const token = await issueGDT({
        ...baseParams,
        signingKey: attacker.privateKey,
        principalDID: principal.did, // claim to be principal but sign with attacker key
      });

      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
    });

    it('rejects token with missing vc claim', async () => {
      // Create a minimal JWT manually
      const key = await import('../src/crypto.js').then((m) => m.importPrivateKey(principal.privateKey, principal.publicKey));
      const { SignJWT } = await import('jose');
      const token = await new SignJWT({} as never)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuer(principal.did)
        .setSubject(agent.did)
        .setIssuedAt()
        .setExpirationTime('1h')
        .setJti('test-id')
        .sign(key);

      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('missing vc.credentialSubject');
    });

    it('rejects token with vc.type missing GrantexDelegationToken', async () => {
      const key = await import('../src/crypto.js').then((m) => m.importPrivateKey(principal.privateKey, principal.publicKey));
      const { SignJWT } = await import('jose');
      const token = await new SignJWT({
        vc: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          type: ['VerifiableCredential'], // missing GrantexDelegationToken
          credentialSubject: {
            id: agent.did,
            scope: ['weather:read'],
            spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
            paymentChain: 'base',
            delegationChain: [principal.did],
          },
        },
      } as never)
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
        .setIssuer(principal.did)
        .setSubject(agent.did)
        .setIssuedAt()
        .setExpirationTime('1h')
        .setJti('test-id')
        .sign(key);

      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('VC type');
    });
  });

  // ── DID edge cases ────────────────────────────────────────────────

  describe('DID edge cases', () => {
    it('handles all-zero public key', () => {
      const zeroKey = new Uint8Array(32);
      const did = publicKeyToDID(zeroKey);
      expect(did).toMatch(/^did:key:z/);
    });

    it('handles all-0xFF public key', () => {
      const maxKey = new Uint8Array(32).fill(0xff);
      const did = publicKeyToDID(maxKey);
      expect(did).toMatch(/^did:key:z/);
    });

    it('base58 round-trips empty array', () => {
      const empty = new Uint8Array(0);
      const encoded = base58btcEncode(empty);
      const decoded = base58btcDecode(encoded);
      expect(decoded).toEqual(empty);
    });

    it('base58 round-trips single byte', () => {
      for (const byte of [0, 1, 127, 255]) {
        const data = new Uint8Array([byte]);
        const encoded = base58btcEncode(data);
        const decoded = base58btcDecode(encoded);
        expect(decoded).toEqual(data);
      }
    });
  });

  // ── Revocation edge cases ─────────────────────────────────────────

  describe('revocation edge cases', () => {
    it('handles revocation without reason', async () => {
      const registry = new InMemoryRevocationRegistry();
      setRevocationRegistry(registry);

      await registry.revoke('token-1');
      const list = await registry.listRevoked();
      expect(list[0]!.tokenId).toBe('token-1');
      expect(list[0]!.reason).toBeUndefined();
    });

    it('handles empty string tokenId', async () => {
      const registry = new InMemoryRevocationRegistry();
      setRevocationRegistry(registry);

      await registry.revoke('');
      expect(await registry.isRevoked('')).toBe(true);
    });
  });
});
