import { beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { generateKeyPair, importPrivateKey } from '../src/crypto.js';
import { base58btcEncode, didToPublicKey, isValidDID } from '../src/did.js';
import { issueGDT } from '../src/gdt.js';
import { verifyGDT } from '../src/verify.js';
import { InMemoryAuditLog, setAuditLog } from '../src/audit.js';
import { InMemoryRevocationRegistry, setRevocationRegistry } from '../src/revocation.js';

beforeEach(() => {
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
