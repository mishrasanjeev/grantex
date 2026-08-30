import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicAmount,
  PrepaidWalletError,
  validateNetwork,
  validateResource,
} from '../src/lib/prepaid-wallet.js';
import {
  signWalletAuthorizationToken,
  verifyWalletAuthorizationToken,
} from '../src/lib/crypto.js';
import { buildTestApp } from './helpers.js';

describe('prepaid wallet value validation', () => {
  it.each([
    ['00042', '42'],
    ['1', '1'],
    ['0', '0'],
  ])('canonicalizes atomic amount %s', (value, expected) => {
    expect(atomicAmount(value, 'amount', value === '0')).toBe(expected);
  });

  it.each([1, 1.5, '-1', '+1', '1.0', '1e6', '', '0'])('rejects unsafe amount %j', (value) => {
    expect(() => atomicAmount(value, 'amount')).toThrow(PrepaidWalletError);
  });

  it('accepts strict CAIP-2 identifiers and rejects lookalikes', () => {
    expect(validateNetwork('grantex:prepaid')).toBe('grantex:prepaid');
    expect(validateNetwork('eip155:8453')).toBe('eip155:8453');
    for (const network of ['GRANTEX:prepaid', 'ab:1', 'namespace-too-long:1', 'grantex:', 'grantex:bad/value']) {
      expect(() => validateNetwork(network)).toThrow(PrepaidWalletError);
    }
  });

  it('requires HTTPS remotely while allowing explicit loopback development resources', () => {
    expect(validateResource('https://merchant.example/paid')).toBe('https://merchant.example/paid');
    expect(validateResource('http://localhost:3402/paid')).toBe('http://localhost:3402/paid');
    expect(validateResource('http://127.0.0.1:3402/paid')).toBe('http://127.0.0.1:3402/paid');
    expect(validateResource('http://[::1]:3402/paid')).toBe('http://[::1]:3402/paid');
    for (const resource of [
      'http://merchant.example/paid',
      'ftp://merchant.example/paid',
      'https://user:secret@merchant.example/paid',
      'https://merchant.example/paid#fragment',
      '/relative',
    ]) {
      expect(() => validateResource(resource)).toThrow(PrepaidWalletError);
    }
  });

  it('binds payment scope to the OAuth grant and keeps custody internals out of agent listings', () => {
    const implementation = readFileSync(join(process.cwd(), 'src', 'lib', 'prepaid-wallet.ts'), 'utf8');
    expect(implementation).toContain("identity.scopes.includes(input.scope)");
    expect(implementation).toContain("'PAYMENT_SCOPE_NOT_GRANTED'");
    const agentListQuery = implementation.slice(
      implementation.indexOf('export async function listAgentWallets'),
      implementation.indexOf('export async function assignWallet'),
    );
    expect(agentListQuery).not.toContain('SELECT w.*');
    expect(agentListQuery).not.toContain('provider_wallet_id');
    expect(agentListQuery).not.toContain('metadata');
  });
});

describe('wallet authorization JWT', () => {
  it('round-trips every payment binding and rejects tampering', async () => {
    await buildTestApp();
    const payload = {
      authorizationId: 'auth_1234567890123456',
      reservationId: 'wres_123', walletId: 'pwal_123', assignmentId: 'wasn_123',
      agentId: 'agt_123', principalId: 'principal_123', developerId: 'dev_123',
      grantId: 'grnt_123', amount: '2500', asset: 'USDC', network: 'grantex:prepaid',
      recipient: 'merchant:weather', resource: 'https://merchant.test/weather',
      scope: 'weather:read', requestHash: 'a'.repeat(64),
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    };
    const token = await signWalletAuthorizationToken(payload);
    await expect(verifyWalletAuthorizationToken(token)).resolves.toEqual(payload);
    const [header, body, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString()) as Record<string, unknown>;
    decoded['amount'] = '1';
    const tampered = `${header}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;
    await expect(verifyWalletAuthorizationToken(tampered)).rejects.toThrow();
  }, 30_000);
});

describe('prepaid wallet migration invariants', () => {
  const migration = readFileSync(join(process.cwd(), 'src', 'db', 'migrations', '091_agent_prepaid_wallets.sql'), 'utf8');

  it('uses integer atomic balances and database-enforced non-negative invariants', () => {
    expect(migration).toContain('NUMERIC(78,0)');
    expect(migration).toContain('available_amount >= 0 AND reserved_amount >= 0');
    expect(migration).toContain('per_transaction_limit <= cumulative_limit');
  });

  it('enforces agent-wide payment idempotency, principal reload idempotency, and one authorization JTI', () => {
    expect(migration).toContain('authorization_jti     TEXT NOT NULL UNIQUE');
    expect(migration).toContain('ON wallet_payment_reservations(developer_id, principal_id, agent_id, idempotency_key_hash)');
    expect(migration).toContain('ON wallet_reload_requests(developer_id, principal_id, idempotency_key_hash)');
    expect(migration).toContain('ON wallet_reload_requests(developer_id, principal_id, agent_id, idempotency_key_hash)');
  });

  it('makes the financial ledger append-only by permission and trigger', () => {
    expect(migration).toContain('GRANT SELECT, INSERT ON wallet_ledger_entries');
    expect(migration).toContain('REVOKE DELETE, TRUNCATE ON prepaid_wallets');
    expect(migration).toContain('trg_wallet_ledger_no_update_delete');
    expect(migration).toContain('trg_wallet_ledger_no_truncate');
  });
});
