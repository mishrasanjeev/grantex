import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { createX402Agent, HEADERS } from '../src/agent.js';
import { generateKeyPair, importPrivateKey } from '../src/crypto.js';
import { base58btcEncode, didToPublicKey, isValidDID } from '../src/did.js';
import { issueGDT } from '../src/gdt.js';
import { verifyGDT } from '../src/verify.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  setAuditLog(new InMemoryAuditLog());
  setRevocationRegistry(new InMemoryRevocationRegistry());
});

async function signedGDT(
  credentialSubject: Record<string, unknown>,
  expiry: boolean | number = true,
): Promise<string> {
  const principal = generateKeyPair();
  const agent = generateKeyPair();
  const key = await importPrivateKey(principal.privateKey, principal.publicKey);
  let jwt = new SignJWT({
    vc: {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential', 'GrantexDelegationToken'],
      credentialSubject: { id: agent.did, ...credentialSubject },
    },
  } as never)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
    .setIssuer(principal.did)
    .setSubject(agent.did)
    .setIssuedAt()
    .setJti('regression-token');
  if (expiry) jwt = jwt.setExpirationTime(typeof expiry === 'number' ? expiry : '1h');
  return jwt.sign(key);
}

const validSubject = {
  scope: ['weather:read'],
  spendLimit: { amount: 10, currency: 'USDC', period: '24h' },
  paymentChain: 'base',
  delegationChain: [],
};

const context = { resource: 'weather:read', amount: 1, currency: 'USDC' as const };

describe('GDT validation regressions', () => {
  it('rejects a credential subject bound to a different agent', async () => {
    const token = await signedGDT({ ...validSubject, id: generateKeyPair().did });
    await expect(verifyGDT(token, context)).resolves.toMatchObject({
      valid: false,
      error: expect.stringContaining('must match'),
    });
  });

  it('rejects missing timestamps and malformed signed credential fields', async () => {
    const noExpiry = await signedGDT(validSubject, false);
    const badScopes = await signedGDT({ ...validSubject, scope: ['weather:read', { admin: true }] });
    const badLimit = await signedGDT({
      ...validSubject,
      spendLimit: { amount: null, currency: 'USDC', period: '24h' },
    });

    expect((await verifyGDT(noExpiry, context)).valid).toBe(false);
    expect((await verifyGDT(badScopes, context)).valid).toBe(false);
    expect((await verifyGDT(badLimit, context)).valid).toBe(false);
  });

  it('returns an invalid result instead of throwing for out-of-range timestamps', async () => {
    const token = await signedGDT(validSubject, 1e300);
    await expect(verifyGDT(token, context)).resolves.toMatchObject({ valid: false });
  });

  it('rejects non-finite issuance limits and invalid spend enums', async () => {
    const principal = generateKeyPair();
    const agent = generateKeyPair();
    const base = {
      agentDID: agent.did,
      scope: ['weather:read'],
      expiry: '1h',
      signingKey: principal.privateKey,
    };

    await expect(issueGDT({
      ...base,
      spendLimit: { amount: Number.NaN, currency: 'USDC', period: '24h' },
    })).rejects.toThrow('positive');
    await expect(issueGDT({
      ...base,
      spendLimit: { amount: 1, currency: 'EUR' as 'USDC', period: '24h' },
    })).rejects.toThrow('currency');
    await expect(issueGDT({
      ...base,
      spendLimit: { amount: 1, currency: 'USDC', period: 'forever' as '24h' },
    })).rejects.toThrow('period');
  });

  it('rejects did:key values with non-Ed25519 key lengths', () => {
    const bytes = new Uint8Array(2 + 33);
    bytes.set([0xed, 0x01]);
    const did = `did:key:z${base58btcEncode(bytes)}`;

    expect(() => didToPublicKey(did)).toThrow('32-byte');
    expect(isValidDID(did)).toBe(false);
  });
});

describe('x402 payment challenge regressions', () => {
  it('does not pay malformed or unsupported challenges', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 402,
      headers: {
        [HEADERS.PAYMENT_AMOUNT]: '1junk',
        [HEADERS.PAYMENT_CURRENCY]: 'USDC',
        [HEADERS.PAYMENT_RECIPIENT]: '0xrecipient',
      },
    }));
    const paymentHandler = vi.fn().mockResolvedValue('proof');

    await expect(createX402Agent({ paymentHandler }).fetch('https://api.example.test'))
      .rejects.toThrow('payment amount');
    expect(paymentHandler).not.toHaveBeenCalled();
  });

  it('does not fall back to permissive headers after parsed JSON fails validation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      amount: 1,
      currency: 'EUR',
      recipientAddress: 'json-recipient',
      chain: 'base',
    }), {
      status: 402,
      headers: {
        'content-type': 'application/json',
        [HEADERS.PAYMENT_AMOUNT]: '1',
        [HEADERS.PAYMENT_CURRENCY]: 'USDC',
        [HEADERS.PAYMENT_RECIPIENT]: 'header-recipient',
      },
    }));
    const paymentHandler = vi.fn().mockResolvedValue('proof');

    await expect(createX402Agent({ paymentHandler }).fetch('https://api.example.test'))
      .rejects.toThrow('unsupported payment currency');
    expect(paymentHandler).not.toHaveBeenCalled();
  });

  it('requires a non-empty proof and records no successful payment for handler failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, {
      status: 402,
      headers: {
        [HEADERS.PAYMENT_AMOUNT]: '1',
        [HEADERS.PAYMENT_CURRENCY]: 'USDC',
        [HEADERS.PAYMENT_RECIPIENT]: '0xrecipient',
      },
    }));
    const audit = new InMemoryAuditLog();
    setAuditLog(audit);

    await expect(createX402Agent({ paymentHandler: async () => '' }).fetch('https://api.example.test'))
      .rejects.toThrow('payment proof');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await audit.query({ eventType: 'payment' })).toHaveLength(0);
  });

  it('does not leak the SDK-only gdt option into the native fetch init', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    await createX402Agent().fetch('https://api.example.test', { gdt: 'token' });

    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty('gdt');
  });
});
