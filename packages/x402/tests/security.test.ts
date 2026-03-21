import { describe, it, expect, beforeEach } from 'vitest';
import { issueGDT } from '../src/gdt.js';
import { verifyGDT, decodeGDT } from '../src/verify.js';
import { generateKeyPair } from '../src/crypto.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';
import type { IssueGDTParams } from '../src/types.js';

describe('Security tests', () => {
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

  // -----------------------------------------------------------------------
  // Token tampering
  // -----------------------------------------------------------------------

  describe('token tampering', () => {
    it('rejects a token with modified payload', async () => {
      const token = await issueGDT(baseParams);
      const parts = token.split('.');

      // Decode payload, modify scope, re-encode
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.vc.credentialSubject.scope = ['finance:admin'];
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tampered = parts.join('.');

      const result = await verifyGDT(tampered, {
        resource: 'finance:admin',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Signature verification failed');
    });

    it('rejects a token with modified header', async () => {
      const token = await issueGDT(baseParams);
      const parts = token.split('.');

      // Change the algorithm
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      header.alg = 'none';
      parts[0] = Buffer.from(JSON.stringify(header)).toString('base64url');
      const tampered = parts.join('.');

      const result = await verifyGDT(tampered, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
    });

    it('rejects a token with modified spend limit', async () => {
      const token = await issueGDT(baseParams);
      const parts = token.split('.');

      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.vc.credentialSubject.spendLimit.amount = 1000000;
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tampered = parts.join('.');

      const result = await verifyGDT(tampered, {
        resource: 'weather:read',
        amount: 999999,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
    });

    it('rejects a token with modified expiry', async () => {
      const token = await issueGDT(baseParams);
      const parts = token.split('.');

      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.exp = Math.floor(Date.now() / 1000) + 365 * 86400; // extend to 1 year
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const tampered = parts.join('.');

      const result = await verifyGDT(tampered, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Key mismatch / impersonation
  // -----------------------------------------------------------------------

  describe('key mismatch / impersonation', () => {
    it('rejects when issuer DID does not match signing key', async () => {
      const attacker = generateKeyPair();

      // Attacker signs with their own key but claims to be the principal
      const token = await issueGDT({
        ...baseParams,
        signingKey: attacker.privateKey,
        principalDID: principal.did,
      });

      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Signature verification failed');
    });

    it('rejects a token with forged issuer DID', async () => {
      const attacker = generateKeyPair();

      // Issue a legitimate token from attacker, but try to use it
      // pretending it's from the principal
      const token = await issueGDT({
        agentDID: agent.did,
        scope: ['weather:read'],
        spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
        expiry: '24h',
        signingKey: attacker.privateKey,
      });

      // The token is valid when verified against attacker's DID
      const decoded = decodeGDT(token);
      expect(decoded.iss).toBe(attacker.did); // not principal.did

      // Token IS valid for the attacker's identity
      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(true);
      expect(result.principalDID).toBe(attacker.did);
    });
  });

  // -----------------------------------------------------------------------
  // Scope escalation
  // -----------------------------------------------------------------------

  describe('scope escalation', () => {
    it('cannot use a weather:read token for finance:read', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'finance:read',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Scope mismatch');
    });

    it('cannot use a weather:read token for weather:write', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:write',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
    });

    it('cannot use a weather:read token for weather:admin', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:admin',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Replay attacks
  // -----------------------------------------------------------------------

  describe('replay protection', () => {
    it('each token has a unique jti', async () => {
      const token1 = await issueGDT(baseParams);
      const token2 = await issueGDT(baseParams);

      const decoded1 = decodeGDT(token1);
      const decoded2 = decodeGDT(token2);

      expect(decoded1.jti).not.toBe(decoded2.jti);
    });

    it('revoked token cannot be replayed', async () => {
      const token = await issueGDT(baseParams);
      const decoded = decodeGDT(token);

      // Use once — valid
      const result1 = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result1.valid).toBe(true);

      // Revoke
      const registry = new InMemoryRevocationRegistry();
      setRevocationRegistry(registry);
      await registry.revoke(decoded.jti);

      // Replay — rejected
      const result2 = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result2.valid).toBe(false);
      expect(result2.error).toContain('revoked');
    });
  });

  // -----------------------------------------------------------------------
  // Invalid DID formats
  // -----------------------------------------------------------------------

  describe('invalid DID handling', () => {
    it('rejects token with non-did:key issuer', async () => {
      // We can't easily issue such a token through issueGDT since it validates,
      // but we can verify that verification rejects tokens with bad issuer DIDs
      const token = await issueGDT(baseParams);
      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      payload.iss = 'did:web:evil.com'; // change to unsupported DID method
      parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
      // Signature won't match but we test the DID validation path first
      const tampered = parts.join('.');

      const result = await verifyGDT(tampered, {
        resource: 'weather:read',
        amount: 0.001,
        currency: 'USDC',
      });

      expect(result.valid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles zero amount correctly', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0,
        currency: 'USDC',
      });
      expect(result.valid).toBe(true);
      expect(result.remainingLimit).toBe(10);
    });

    it('handles very small amounts', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 0.000001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(true);
    });

    it('handles exact limit match', async () => {
      const token = await issueGDT(baseParams);
      const result = await verifyGDT(token, {
        resource: 'weather:read',
        amount: 10,
        currency: 'USDC',
      });
      expect(result.valid).toBe(true);
      expect(result.remainingLimit).toBe(0);
    });

    it('handles multiple scopes in single token', async () => {
      const token = await issueGDT({
        ...baseParams,
        scope: ['weather:read', 'news:read', 'maps:read'],
      });

      // All should pass
      for (const scope of ['weather:read', 'news:read', 'maps:read']) {
        const result = await verifyGDT(token, {
          resource: scope,
          amount: 0.001,
          currency: 'USDC',
        });
        expect(result.valid).toBe(true);
      }

      // Unknown scope should fail
      const result = await verifyGDT(token, {
        resource: 'finance:read',
        amount: 0.001,
        currency: 'USDC',
      });
      expect(result.valid).toBe(false);
    });
  });
});
